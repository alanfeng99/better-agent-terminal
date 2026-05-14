use crate::commands::{
    agent as agent_cmd, fs as fs_cmd, git as git_cmd, github as github_cmd, image as image_cmd,
    profile as profile_cmd, settings as settings_cmd, snippet as snippet_cmd,
    worktree as worktree_cmd,
};
use crate::electron_safe_storage::{
    read_secret_json, read_secret_string, write_secret_json, write_secret_string, SecretJsonRead,
};
use crate::network_addresses;
use crate::remote_core::{
    event_params_to_legacy_v1_args, legacy_v1_args_to_params, negotiate_remote_protocol,
    RemoteProtocol, REMOTE_PROTOCOL_LEGACY_V1, REMOTE_PROTOCOL_V2,
};
use crate::sidecar::{app_handle_emit_sink, resolve_spawn_config, SidecarState};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rcgen::{generate_simple_self_signed, CertifiedKey};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::{Role, WebSocket};
use tungstenite::Message;

const DEFAULT_REMOTE_PORT: u16 = 9876;
const INVOKE_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_INVOKE_TIMEOUT: Duration = Duration::from_secs(300);
const TOKEN_FILE: &str = "server-token.enc.json";
const LEGACY_TOKEN_FILE: &str = "server-token.json";
const CERT_FILE: &str = "server-cert.enc.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClientInfo {
    pub label: String,
    pub window_id: Option<String>,
    pub connected_at: u64,
    pub protocol: String,
}

#[derive(Debug, Clone)]
pub struct RemoteConnectionInfo {
    pub port: u16,
    pub token: String,
    pub fingerprint: String,
    pub bound_host: String,
}

#[derive(Debug)]
struct RunningServer {
    port: u16,
    token: String,
    fingerprint: String,
    bind_interface: String,
    bound_host: String,
    clients: Arc<Mutex<Vec<RemoteClientRecord>>>,
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Debug)]
struct RemoteClientRecord {
    id: String,
    info: RemoteClientInfo,
    tx: mpsc::Sender<Value>,
}

#[derive(Default)]
pub struct RustRemoteServerState {
    inner: Mutex<Option<RunningServer>>,
}

impl RustRemoteServerState {
    pub fn start(
        &self,
        app: AppHandle,
        sidecar: SidecarState,
        options: Option<Value>,
    ) -> Result<Value, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "remote server lock poisoned")?;
        if let Some(running) = guard.as_ref() {
            return Ok(start_result(running));
        }

        let opts = options.unwrap_or(Value::Null);
        let requested_port = opts
            .get("port")
            .and_then(|value| value.as_u64())
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(DEFAULT_REMOTE_PORT);
        let bind_interface = normalize_bind_interface(
            opts.get("bindInterface")
                .and_then(|value| value.as_str())
                .unwrap_or("localhost"),
        );
        let bound_host = network_addresses::bound_host_for_interface(&bind_interface);
        let data_dir = crate::app_data::app_data_dir(&app)?;
        fs::create_dir_all(&data_dir)
            .map_err(|err| format!("remote data dir creation failed: {err}"))?;

        let token = opts
            .get("token")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| load_persisted_token(&data_dir))
            .unwrap_or_else(generate_token);
        persist_token(&data_dir, &token);

        let cert = ensure_remote_certificate(&data_dir)?;
        let fingerprint = fingerprint_sha256(&cert.cert_der);
        let config = Arc::new(build_tls_config(&cert)?);
        let listener = TcpListener::bind((bound_host.as_str(), requested_port))
            .map_err(|err| format!("remote server bind failed: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("remote server nonblocking failed: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("remote server local_addr failed: {err}"))?
            .port();

        let clients = Arc::new(Mutex::new(Vec::new()));
        let (stop_tx, stop_rx) = mpsc::channel();
        let thread_clients = Arc::clone(&clients);
        let thread_token = token.clone();
        let thread_app = app.clone();
        let thread_sidecar = sidecar.clone();
        let log_bound_host = bound_host.clone();
        let log_bind_interface = bind_interface.clone();
        let log_fingerprint = fingerprint.clone();
        let handle = thread::spawn(move || {
            remote_debug_log(
                &thread_app,
                format!(
                    "server started host={} port={} iface={} fingerprint={}",
                    log_bound_host,
                    port,
                    log_bind_interface,
                    log_fingerprint.chars().take(23).collect::<String>()
                ),
            );
            run_accept_loop(
                listener,
                config,
                thread_token,
                thread_app,
                thread_sidecar,
                thread_clients,
                stop_rx,
            );
        });

        let running = RunningServer {
            port,
            token,
            fingerprint,
            bind_interface,
            bound_host,
            clients,
            stop: stop_tx,
            thread: Some(handle),
        };
        let result = start_result(&running);
        *guard = Some(running);
        Ok(result)
    }

    pub fn stop(&self) -> bool {
        let Ok(mut guard) = self.inner.lock() else {
            return false;
        };
        let Some(mut running) = guard.take() else {
            return true;
        };
        let _ = running.stop.send(());
        if let Some(handle) = running.thread.take() {
            let _ = handle.join();
        }
        true
    }

    pub fn status(&self) -> Value {
        let Ok(guard) = self.inner.lock() else {
            return json!({ "running": false, "port": null, "fingerprint": null, "bindInterface": null, "boundHost": null, "clients": [] });
        };
        let Some(running) = guard.as_ref() else {
            return json!({ "running": false, "port": null, "fingerprint": null, "bindInterface": null, "boundHost": null, "clients": [] });
        };
        let clients = running
            .clients
            .lock()
            .map(|clients| {
                clients
                    .iter()
                    .map(|client| client.info.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        json!({
            "running": true,
            "port": running.port,
            "fingerprint": running.fingerprint,
            "bindInterface": running.bind_interface,
            "boundHost": running.bound_host,
            "clients": clients,
        })
    }

    pub fn connection_info(&self) -> Option<RemoteConnectionInfo> {
        let guard = self.inner.lock().ok()?;
        let running = guard.as_ref()?;
        Some(RemoteConnectionInfo {
            port: running.port,
            token: running.token.clone(),
            fingerprint: running.fingerprint.clone(),
            bound_host: running.bound_host.clone(),
        })
    }

    pub fn broadcast_event(&self, channel: &str, params: &Value) {
        let args = event_params_to_legacy_v1_args(channel, params);
        let frame = json!({ "type": "event", "channel": channel, "args": args });
        let clients = {
            let Ok(guard) = self.inner.lock() else {
                return;
            };
            let Some(running) = guard.as_ref() else {
                return;
            };
            Arc::clone(&running.clients)
        };
        if let Ok(mut clients) = clients.lock() {
            clients.retain(|client| client.tx.send(frame.clone()).is_ok());
        };
    }
}

impl Drop for RustRemoteServerState {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct RemoteCertificate {
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCertificate {
    cert: String,
    private_key: String,
    created_at: u64,
}

fn load_persisted_token(data_dir: &Path) -> Option<String> {
    match read_secret_string(data_dir, &data_dir.join(TOKEN_FILE)) {
        SecretJsonRead::Read(token) if !token.is_empty() => Some(token),
        _ => load_legacy_plaintext_token(data_dir),
    }
}

fn load_legacy_plaintext_token(data_dir: &Path) -> Option<String> {
    let path = data_dir.join(LEGACY_TOKEN_FILE);
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    value
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn persist_token(data_dir: &Path, token: &str) {
    let _ = write_secret_string(data_dir, &data_dir.join(TOKEN_FILE), token);
}

fn ensure_remote_certificate(data_dir: &Path) -> Result<RemoteCertificate, String> {
    let cert_path = data_dir.join(CERT_FILE);
    if let SecretJsonRead::Read(stored) =
        read_secret_json::<StoredCertificate>(data_dir, &cert_path)
    {
        if let Ok(cert) = stored_certificate_to_remote(&stored) {
            return Ok(cert);
        }
    }

    let stored = generate_stored_certificate()?;
    let cert = stored_certificate_to_remote(&stored)?;
    let _ = write_secret_json(data_dir, &cert_path, &stored);
    Ok(cert)
}

#[cfg(test)]
fn generate_remote_certificate() -> Result<RemoteCertificate, String> {
    stored_certificate_to_remote(&generate_stored_certificate()?)
}

fn generate_stored_certificate() -> Result<StoredCertificate, String> {
    let subject_alt_names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    let CertifiedKey { cert, signing_key } = generate_simple_self_signed(subject_alt_names)
        .map_err(|err| format!("remote certificate generation failed: {err}"))?;
    Ok(StoredCertificate {
        cert: cert.pem(),
        private_key: signing_key.serialize_pem(),
        created_at: unix_ms(),
    })
}

fn stored_certificate_to_remote(stored: &StoredCertificate) -> Result<RemoteCertificate, String> {
    let cert_der = pem_to_der(&stored.cert, "CERTIFICATE")
        .ok_or_else(|| "remote certificate PEM parse failed".to_string())?;
    let key_der = pem_to_der(&stored.private_key, "PRIVATE KEY")
        .or_else(|| pem_to_der(&stored.private_key, "RSA PRIVATE KEY"))
        .or_else(|| pem_to_der(&stored.private_key, "EC PRIVATE KEY"))
        .ok_or_else(|| "remote private key PEM parse failed".to_string())?;
    Ok(RemoteCertificate { cert_der, key_der })
}

fn pem_to_der(pem: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let after_begin = pem.split(&begin).nth(1)?;
    let body = after_begin.split(&end).next()?;
    let encoded = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<String>();
    B64.decode(encoded).ok()
}

fn build_tls_config(cert: &RemoteCertificate) -> Result<ServerConfig, String> {
    let provider = rustls::crypto::ring::default_provider();
    ServerConfig::builder_with_provider(provider.into())
        .with_safe_default_protocol_versions()
        .map_err(|err| format!("remote TLS protocol config failed: {err:?}"))?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.cert_der.clone())],
            PrivateKeyDer::try_from(cert.key_der.clone())
                .map_err(|err| format!("remote TLS private key parse failed: {err}"))?,
        )
        .map_err(|err| format!("remote TLS certificate config failed: {err}"))
}

fn fingerprint_sha256(cert_der: &[u8]) -> String {
    let digest = Sha256::digest(cert_der);
    digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn normalize_bind_interface(value: &str) -> String {
    match value {
        "localhost" | "tailscale" | "all" => value.to_string(),
        _ => "localhost".to_string(),
    }
}

fn generate_token() -> String {
    let bytes = rand::random::<[u8; 16]>();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn start_result(running: &RunningServer) -> Value {
    json!({
        "port": running.port,
        "token": running.token,
        "fingerprint": running.fingerprint,
        "bindInterface": running.bind_interface,
        "boundHost": running.bound_host,
    })
}

fn run_accept_loop(
    listener: TcpListener,
    config: Arc<ServerConfig>,
    token: String,
    app: AppHandle,
    sidecar: SidecarState,
    clients: Arc<Mutex<Vec<RemoteClientRecord>>>,
    stop_rx: mpsc::Receiver<()>,
) {
    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match listener.accept() {
            Ok((stream, addr)) => {
                let config = Arc::clone(&config);
                let token = token.clone();
                let app = app.clone();
                let sidecar = sidecar.clone();
                let clients = Arc::clone(&clients);
                let peer = addr.to_string();
                remote_debug_log(&app, format!("tcp accepted peer={peer}"));
                thread::spawn(move || {
                    if let Err(err) = handle_client(
                        stream,
                        config,
                        token,
                        app.clone(),
                        sidecar,
                        clients,
                        peer.clone(),
                    ) {
                        remote_debug_log(&app, format!("client closed peer={peer} error={err}"));
                    }
                });
            }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => break,
        }
    }
}

fn handle_client(
    stream: TcpStream,
    config: Arc<ServerConfig>,
    token: String,
    app: AppHandle,
    sidecar: SidecarState,
    clients: Arc<Mutex<Vec<RemoteClientRecord>>>,
    peer: String,
) -> Result<(), String> {
    stream
        .set_nonblocking(false)
        .map_err(|err| format!("remote stream blocking mode failed: {err}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|err| format!("remote stream timeout failed: {err}"))?;
    let connection =
        ServerConnection::new(config).map_err(|err| format!("remote TLS failed: {err}"))?;
    let tls = StreamOwned::new(connection, stream);
    let mut ws = accept_websocket_tls(tls)
        .map_err(|err| format!("remote websocket accept failed: {err}"))?;
    ws.get_mut()
        .sock
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|err| format!("remote stream polling timeout failed: {err}"))?;
    remote_debug_log(&app, format!("websocket accepted peer={peer}"));
    let mut authenticated = false;
    let mut client_label = String::from("Remote Client");
    let mut client_id = String::new();
    let mut client_protocol = RemoteProtocol::LegacyV1;
    let (out_tx, out_rx) = mpsc::channel::<Value>();

    loop {
        while let Ok(frame) = out_rx.try_recv() {
            send_frame(&mut ws, frame)?;
        }
        let msg = match ws.read() {
            Ok(msg) => msg,
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(_) => break,
        };
        let Message::Text(text) = msg else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
        let id = frame.get("id").cloned().unwrap_or(Value::Null);

        if frame_type == "auth" {
            if frame.get("token").and_then(Value::as_str) != Some(token.as_str()) {
                remote_debug_log(
                    &app,
                    format!("auth failed peer={peer} reason=invalid-token"),
                );
                send_frame(
                    &mut ws,
                    json!({ "type": "auth-result", "id": id, "error": "Invalid token" }),
                )?;
                break;
            }
            let offered = frame
                .get("protocols")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .or_else(|| {
                    frame
                        .get("protocol")
                        .and_then(Value::as_str)
                        .map(|value| vec![value.to_string()])
                })
                .unwrap_or_default();
            let Some(protocol) = negotiate_remote_protocol(&offered) else {
                remote_debug_log(
                    &app,
                    format!(
                        "auth failed peer={peer} reason=unsupported-protocol offered={offered:?}"
                    ),
                );
                send_frame(
                    &mut ws,
                    json!({ "type": "auth-result", "id": id, "error": "Unsupported remote protocol" }),
                )?;
                break;
            };
            client_protocol = protocol;
            let label = frame
                .get("args")
                .and_then(Value::as_array)
                .and_then(|args| args.first())
                .and_then(Value::as_str)
                .unwrap_or("Remote Client")
                .to_string();
            let window_id = frame
                .get("args")
                .and_then(Value::as_array)
                .and_then(|args| args.get(1))
                .and_then(|value| value.get("windowId"))
                .and_then(Value::as_str)
                .map(str::to_string);
            client_label = label.clone();
            let protocol_name = protocol.as_str().to_string();
            client_id = format!("{}-{}", unix_ms(), generate_token());
            if let Ok(mut guard) = clients.lock() {
                guard.push(RemoteClientRecord {
                    id: client_id.clone(),
                    info: RemoteClientInfo {
                        label,
                        window_id,
                        connected_at: unix_ms(),
                        protocol: protocol_name.clone(),
                    },
                    tx: out_tx.clone(),
                });
            }
            authenticated = true;
            remote_debug_log(
                &app,
                format!("auth ok peer={peer} label={client_label} protocol={protocol_name}"),
            );
            send_frame(
                &mut ws,
                json!({ "type": "auth-result", "id": id, "result": true, "protocol": protocol_name }),
            )?;
            continue;
        }

        if !authenticated {
            break;
        }
        if frame_type == "ping" {
            send_frame(&mut ws, json!({ "type": "pong", "id": id }))?;
            continue;
        }
        if frame_type == "invoke" {
            let channel = frame
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            remote_debug_log(&app, format!("invoke start peer={peer} channel={channel}"));
            let invoke_app = app.clone();
            let invoke_sidecar = sidecar.clone();
            let invoke_peer = peer.clone();
            let invoke_frame = frame.clone();
            let invoke_tx = out_tx.clone();
            thread::spawn(move || {
                let result = invoke_sidecar_for_remote(
                    &invoke_app,
                    &invoke_sidecar,
                    client_protocol,
                    &channel,
                    &invoke_frame,
                );
                let response = match result {
                    Ok(value) => {
                        remote_debug_log(
                            &invoke_app,
                            format!("invoke ok peer={invoke_peer} channel={channel}"),
                        );
                        json!({ "type": "invoke-result", "id": id, "result": value })
                    }
                    Err(err) => {
                        remote_debug_log(
                            &invoke_app,
                            format!(
                                "invoke error peer={invoke_peer} channel={channel} error={err}"
                            ),
                        );
                        json!({ "type": "invoke-error", "id": id, "error": err })
                    }
                };
                let _ = invoke_tx.send(response);
            });
            continue;
        }
    }
    if let Ok(mut guard) = clients.lock() {
        guard.retain(|client| {
            if client_id.is_empty() {
                client.info.label != client_label
            } else {
                client.id != client_id
            }
        });
    }
    Ok(())
}

fn remote_debug_enabled() -> bool {
    matches!(std::env::var("BAT_DEBUG").as_deref(), Ok("1") | Ok("true"))
}

fn remote_debug_log(app: &AppHandle, message: impl AsRef<str>) {
    if remote_debug_enabled() {
        crate::commands::app::log_tauri(app, &format!("[remote-server] {}", message.as_ref()));
    }
}

fn accept_websocket_tls(
    mut tls: StreamOwned<ServerConnection, TcpStream>,
) -> Result<WebSocket<StreamOwned<ServerConnection, TcpStream>>, String> {
    let mut request = Vec::with_capacity(1024);
    let mut buf = [0_u8; 1024];
    let deadline = Instant::now() + Duration::from_secs(10);
    while request.len() < 16 * 1024 {
        let n = match tls.read(&mut buf) {
            Ok(n) => n,
            Err(err)
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    return Err("websocket request read timed out".to_string());
                }
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(err) => return Err(format!("websocket request read failed: {err}")),
        };
        if n == 0 {
            return Err("websocket request closed before headers".to_string());
        }
        request.extend_from_slice(&buf[..n]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if !request.windows(4).any(|window| window == b"\r\n\r\n") {
        return Err("websocket request headers too large".to_string());
    }

    let accept_key = websocket_accept_key_from_request(&request)?;
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept_key}\r\n\
         \r\n"
    );
    tls.write_all(response.as_bytes())
        .map_err(|err| format!("websocket response write failed: {err}"))?;
    tls.flush()
        .map_err(|err| format!("websocket response flush failed: {err}"))?;

    Ok(WebSocket::from_raw_socket(tls, Role::Server, None))
}

fn websocket_accept_key_from_request(request: &[u8]) -> Result<String, String> {
    let header_end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "websocket request missing header terminator".to_string())?;
    let raw = std::str::from_utf8(&request[..header_end])
        .map_err(|err| format!("websocket request headers are not utf-8: {err}"))?;
    let mut lines = raw.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    if !request_line.starts_with("GET ") {
        return Err("websocket request must use GET".to_string());
    }

    let mut upgrade_ok = false;
    let mut connection_ok = false;
    let mut version_ok = false;
    let mut key = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "upgrade" => upgrade_ok = value.eq_ignore_ascii_case("websocket"),
            "connection" => {
                connection_ok = value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
            }
            "sec-websocket-version" => version_ok = value == "13",
            "sec-websocket-key" => key = Some(value.to_string()),
            _ => {}
        }
    }
    if !upgrade_ok {
        return Err("websocket request missing Upgrade: websocket".to_string());
    }
    if !connection_ok {
        return Err("websocket request missing Connection: Upgrade".to_string());
    }
    if !version_ok {
        return Err("websocket request missing Sec-WebSocket-Version: 13".to_string());
    }
    let key = key.ok_or_else(|| "websocket request missing Sec-WebSocket-Key".to_string())?;
    let key_bytes = B64
        .decode(&key)
        .map_err(|_| "websocket request has invalid Sec-WebSocket-Key".to_string())?;
    if key_bytes.len() != 16 {
        return Err("websocket request Sec-WebSocket-Key must decode to 16 bytes".to_string());
    }
    Ok(derive_accept_key(key.as_bytes()))
}

fn invoke_sidecar_for_remote(
    app: &AppHandle,
    sidecar: &SidecarState,
    protocol: RemoteProtocol,
    channel: &str,
    frame: &Value,
) -> Result<Value, String> {
    if channel.is_empty() {
        return Err("remote invoke: missing channel".to_string());
    }
    let args = frame
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let params = match protocol {
        RemoteProtocol::V2 => frame
            .get("params")
            .cloned()
            .unwrap_or_else(|| legacy_v1_args_to_params(channel, &args)),
        RemoteProtocol::LegacyV1 => legacy_v1_args_to_params(channel, &args),
    };
    if let Some(result) = invoke_rust_for_remote(app, channel, &params) {
        return result;
    }
    let method = channel_to_sidecar_method(channel);
    let cfg = resolve_spawn_config(app).map_err(|err| err.message)?;
    let sink = app_handle_emit_sink(app.clone());
    let timeout = remote_invoke_timeout(channel);
    sidecar
        .call_with_emit(&cfg, Some(sink), &method, params, timeout)
        .map_err(|err| err.message)
}

fn profile_id_from_params(channel: &str, params: &Value) -> Result<String, String> {
    let profile_id = params
        .get("profileId")
        .and_then(Value::as_str)
        .or_else(|| params.as_str())
        .unwrap_or("")
        .trim();
    if profile_id.is_empty() {
        Err(format!("{channel}: profileId is required"))
    } else {
        Ok(profile_id.to_string())
    }
}

fn string_param(params: &Value, key: &str, method: &str) -> Result<String, String> {
    string_param_any(params, &[key], method)
}

fn string_param_any(params: &Value, keys: &[&str], method: &str) -> Result<String, String> {
    if let Some(value) = params.as_str() {
        return Ok(value.to_string());
    }
    for key in keys {
        if let Some(value) = params.get(*key).and_then(Value::as_str) {
            return Ok(value.to_string());
        }
    }
    Err(format!(
        "{method}: missing {}",
        keys.first().copied().unwrap_or("string")
    ))
}

fn optional_string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn i64_param(params: &Value, key: &str, method: &str) -> Result<i64, String> {
    if let Some(value) = params.as_i64() {
        return Ok(value);
    }
    params
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{method}: missing {key}"))
}

fn bool_param(params: &Value, key: &str, default: bool) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn string_vec_param(params: &Value, key: &str, method: &str) -> Result<Vec<String>, String> {
    let Some(values) = params.get(key).and_then(Value::as_array) else {
        return Err(format!("{method}: missing {key}"));
    };
    Ok(values
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect())
}

fn deserialize_param<T: DeserializeOwned>(
    value: Value,
    method: &str,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(value).map_err(|err| format!("{method}: invalid {key}: {err}"))
}

fn to_json_value<T: Serialize>(method: &str, value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| format!("{method} serialization failed: {err}"))
}

fn bridge_error_message(err: crate::sidecar::BridgeError) -> String {
    err.message
}

fn invoke_rust_for_remote(
    app: &AppHandle,
    channel: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "agent:list-presets" => Ok(agent_cmd::agent_preset_ids()),
        "settings:load" => tauri::async_runtime::block_on(settings_cmd::settings_load(app.clone()))
            .map_err(|err| err.to_string())
            .and_then(|value| to_json_value(channel, value)),
        "settings:save" => string_param(params, "data", channel).and_then(|data| {
            tauri::async_runtime::block_on(settings_cmd::settings_save(app.clone(), data))
                .map_err(|err| err.to_string())?;
            Ok(Value::Bool(true))
        }),
        "settings:get-shell-path" => string_param(params, "shellType", channel)
            .map(settings_cmd::settings_get_shell_path)
            .and_then(|value| to_json_value(channel, value)),
        "settings:detect-cx" => {
            tauri::async_runtime::block_on(settings_cmd::settings_detect_cx(app.clone()))
                .map_err(|err| err.to_string())
                .and_then(|value| to_json_value(channel, value))
        }
        "fs:home" => to_json_value(channel, fs_cmd::fs_home(app.clone())),
        "fs:readdir" => {
            string_param_any(params, &["dirPath", "path"], channel).and_then(|dir_path| {
                let value = tauri::async_runtime::block_on(fs_cmd::fs_readdir(dir_path));
                to_json_value(channel, value)
            })
        }
        "fs:readFile" => {
            string_param_any(params, &["path", "filePath"], channel).and_then(|path| {
                let value = tauri::async_runtime::block_on(fs_cmd::fs_read_file(path));
                to_json_value(channel, value)
            })
        }
        "fs:list-dirs" => {
            string_param_any(params, &["dirPath", "path"], channel).and_then(|dir_path| {
                let include_hidden = bool_param(params, "includeHidden", false);
                let value = tauri::async_runtime::block_on(fs_cmd::fs_list_dirs(
                    app.clone(),
                    dir_path,
                    include_hidden,
                ));
                to_json_value(channel, value)
            })
        }
        "fs:mkdir" => string_param(params, "parentPath", channel).and_then(|parent_path| {
            string_param(params, "name", channel).and_then(|name| {
                let value = tauri::async_runtime::block_on(fs_cmd::fs_mkdir(parent_path, name));
                to_json_value(channel, value)
            })
        }),
        "fs:delete-path" => {
            string_param_any(params, &["targetPath", "path"], channel).and_then(|target_path| {
                let value = tauri::async_runtime::block_on(fs_cmd::fs_delete_path(target_path));
                to_json_value(channel, value)
            })
        }
        "fs:quick-locations" => {
            let value = tauri::async_runtime::block_on(fs_cmd::fs_quick_locations(app.clone()));
            to_json_value(channel, value)
        }
        "fs:search" => {
            let dir_path = match string_param_any(params, &["dirPath", "path"], channel) {
                Ok(value) => value,
                Err(_) => return Some(Ok(Value::Array(Vec::new()))),
            };
            let query = match string_param(params, "query", channel) {
                Ok(value) => value,
                Err(_) => return Some(Ok(Value::Array(Vec::new()))),
            };
            let value = tauri::async_runtime::block_on(fs_cmd::fs_search(dir_path, query));
            to_json_value(channel, value)
        }
        "fs:resolve-path-links" => string_param(params, "cwd", channel).and_then(|cwd| {
            string_vec_param(params, "rawPaths", channel).and_then(|raw_paths| {
                let value =
                    tauri::async_runtime::block_on(fs_cmd::fs_resolve_path_links(cwd, raw_paths));
                to_json_value(channel, value)
            })
        }),
        "fs:watch" => string_param_any(params, &["dirPath", "path"], channel).map(|dir_path| {
            Value::Bool(fs_cmd::fs_watch(
                app.clone(),
                app.state::<fs_cmd::FsWatcherState>(),
                dir_path,
            ))
        }),
        "fs:unwatch" => string_param_any(params, &["dirPath", "path"], channel).map(|dir_path| {
            Value::Bool(fs_cmd::fs_unwatch(
                app.state::<fs_cmd::FsWatcherState>(),
                dir_path,
            ))
        }),
        "git:get-github-url" => {
            string_param_any(params, &["folderPath", "cwd"], channel).and_then(|folder_path| {
                let value =
                    tauri::async_runtime::block_on(git_cmd::git_get_github_url(folder_path));
                to_json_value(channel, value)
            })
        }
        "git:branch" => string_param(params, "cwd", channel).and_then(|cwd| {
            let value = tauri::async_runtime::block_on(git_cmd::git_get_branch(cwd));
            to_json_value(channel, value)
        }),
        "git:log" => string_param(params, "cwd", channel).and_then(|cwd| {
            let count = params.get("count").and_then(Value::as_i64);
            let value = tauri::async_runtime::block_on(git_cmd::git_get_log(cwd, count));
            to_json_value(channel, value)
        }),
        "git:diff" => string_param(params, "cwd", channel).and_then(|cwd| {
            let commit_hash = optional_string_param(params, "commitHash");
            let file_path = optional_string_param(params, "filePath");
            let value =
                tauri::async_runtime::block_on(git_cmd::git_get_diff(cwd, commit_hash, file_path));
            to_json_value(channel, value)
        }),
        "git:diff-files" => string_param(params, "cwd", channel).and_then(|cwd| {
            let commit_hash = optional_string_param(params, "commitHash");
            let value =
                tauri::async_runtime::block_on(git_cmd::git_get_diff_files(cwd, commit_hash));
            to_json_value(channel, value)
        }),
        "git:getRoot" => string_param(params, "cwd", channel).and_then(|cwd| {
            let value = tauri::async_runtime::block_on(git_cmd::git_get_root(cwd));
            to_json_value(channel, value)
        }),
        "git:status" => string_param(params, "cwd", channel).and_then(|cwd| {
            let value = tauri::async_runtime::block_on(git_cmd::git_get_status(cwd));
            to_json_value(channel, value)
        }),
        "github:check-cli" => {
            let value = tauri::async_runtime::block_on(github_cmd::github_check_cli());
            to_json_value(channel, value)
        }
        "github:pr-list" => string_param(params, "cwd", channel)
            .map(|cwd| tauri::async_runtime::block_on(github_cmd::github_pr_list(cwd))),
        "github:issue-list" => string_param(params, "cwd", channel)
            .map(|cwd| tauri::async_runtime::block_on(github_cmd::github_issue_list(cwd))),
        "github:pr-view" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).map(|number| {
                tauri::async_runtime::block_on(github_cmd::github_pr_view(cwd, number))
            })
        }),
        "github:issue-view" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).map(|number| {
                tauri::async_runtime::block_on(github_cmd::github_issue_view(cwd, number))
            })
        }),
        "github:pr-comment" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).and_then(|number| {
                string_param(params, "body", channel).map(|body| {
                    tauri::async_runtime::block_on(github_cmd::github_pr_comment(cwd, number, body))
                })
            })
        }),
        "github:issue-comment" => string_param(params, "cwd", channel).and_then(|cwd| {
            i64_param(params, "number", channel).and_then(|number| {
                string_param(params, "body", channel).map(|body| {
                    tauri::async_runtime::block_on(github_cmd::github_issue_comment(
                        cwd, number, body,
                    ))
                })
            })
        }),
        "image:read-as-data-url" => string_param_any(params, &["path", "filePath"], channel)
            .and_then(|path| {
                tauri::async_runtime::block_on(image_cmd::image_read_as_data_url(path))
                    .map(Value::String)
                    .map_err(|err| err.to_string())
            }),
        "snippet:getAll" => to_json_value(
            channel,
            snippet_cmd::snippet_get_all(app.clone(), app.state::<snippet_cmd::SnippetState>()),
        ),
        "snippet:getById" => i64_param(params, "id", channel).and_then(|id| {
            to_json_value(
                channel,
                snippet_cmd::snippet_get_by_id(
                    app.clone(),
                    app.state::<snippet_cmd::SnippetState>(),
                    id,
                ),
            )
        }),
        "snippet:getFavorites" => to_json_value(
            channel,
            snippet_cmd::snippet_get_favorites(
                app.clone(),
                app.state::<snippet_cmd::SnippetState>(),
            ),
        ),
        "snippet:search" => {
            let query = match string_param(params, "query", channel) {
                Ok(value) => value,
                Err(_) => return Some(Ok(Value::Array(Vec::new()))),
            };
            to_json_value(
                channel,
                snippet_cmd::snippet_search(
                    app.clone(),
                    app.state::<snippet_cmd::SnippetState>(),
                    query,
                ),
            )
        }
        "snippet:getByWorkspace" => {
            let workspace_id = params
                .as_str()
                .map(ToString::to_string)
                .or_else(|| optional_string_param(params, "workspaceId"));
            to_json_value(
                channel,
                snippet_cmd::snippet_get_by_workspace(
                    app.clone(),
                    app.state::<snippet_cmd::SnippetState>(),
                    workspace_id,
                ),
            )
        }
        "snippet:getCategories" => to_json_value(
            channel,
            snippet_cmd::snippet_get_categories(
                app.clone(),
                app.state::<snippet_cmd::SnippetState>(),
            ),
        ),
        "snippet:create" => {
            let input_value = params
                .get("input")
                .cloned()
                .unwrap_or_else(|| params.clone());
            if !input_value
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
                || !input_value.get("content").and_then(Value::as_str).is_some()
            {
                Err("snippet:create: missing input.title / input.content".to_string())
            } else {
                deserialize_param::<snippet_cmd::CreateSnippetInput>(input_value, channel, "input")
                    .and_then(|input| {
                        to_json_value(
                            channel,
                            snippet_cmd::snippet_create(
                                app.clone(),
                                app.state::<snippet_cmd::SnippetState>(),
                                input,
                            ),
                        )
                    })
            }
        }
        "snippet:update" => i64_param(params, "id", channel).and_then(|id| {
            let updates_value = params
                .get("updates")
                .cloned()
                .ok_or_else(|| "snippet:update: missing updates".to_string())?;
            deserialize_param::<snippet_cmd::UpdateSnippetInput>(updates_value, channel, "updates")
                .and_then(|updates| {
                    to_json_value(
                        channel,
                        snippet_cmd::snippet_update(
                            app.clone(),
                            app.state::<snippet_cmd::SnippetState>(),
                            id,
                            updates,
                        ),
                    )
                })
        }),
        "snippet:delete" => i64_param(params, "id", channel).map(|id| {
            Value::Bool(snippet_cmd::snippet_delete(
                app.clone(),
                app.state::<snippet_cmd::SnippetState>(),
                id,
            ))
        }),
        "snippet:toggleFavorite" => i64_param(params, "id", channel).and_then(|id| {
            to_json_value(
                channel,
                snippet_cmd::snippet_toggle_favorite(
                    app.clone(),
                    app.state::<snippet_cmd::SnippetState>(),
                    id,
                ),
            )
        }),
        "worktree:create" => string_param(params, "sessionId", channel).and_then(|session_id| {
            string_param(params, "cwd", channel).and_then(|cwd| {
                let install_pnpm = Some(bool_param(params, "installPnpm", false));
                tauri::async_runtime::block_on(worktree_cmd::worktree_create(
                    app.clone(),
                    app.state::<worktree_cmd::WorktreeState>(),
                    session_id,
                    cwd,
                    install_pnpm,
                ))
                .map_err(bridge_error_message)
            })
        }),
        "worktree:remove" => string_param(params, "sessionId", channel).and_then(|session_id| {
            let delete_branch = bool_param(params, "deleteBranch", true);
            tauri::async_runtime::block_on(worktree_cmd::worktree_remove(
                app.state::<worktree_cmd::WorktreeState>(),
                session_id,
                delete_branch,
            ))
            .map_err(bridge_error_message)
        }),
        "worktree:status" => string_param(params, "sessionId", channel).and_then(|session_id| {
            tauri::async_runtime::block_on(worktree_cmd::worktree_status(
                app.state::<worktree_cmd::WorktreeState>(),
                session_id,
            ))
            .map_err(bridge_error_message)
        }),
        "worktree:merge" => string_param(params, "sessionId", channel).and_then(|session_id| {
            let strategy =
                optional_string_param(params, "strategy").unwrap_or_else(|| "merge".into());
            tauri::async_runtime::block_on(worktree_cmd::worktree_merge(
                app.state::<worktree_cmd::WorktreeState>(),
                session_id,
                strategy,
            ))
            .map_err(bridge_error_message)
        }),
        "worktree:rehydrate" => string_param(params, "sessionId", channel).and_then(|session_id| {
            string_param(params, "cwd", channel).and_then(|cwd| {
                string_param(params, "worktreePath", channel).and_then(|worktree_path| {
                    string_param(params, "branchName", channel).and_then(|branch_name| {
                        tauri::async_runtime::block_on(worktree_cmd::worktree_rehydrate(
                            app.state::<worktree_cmd::WorktreeState>(),
                            session_id,
                            cwd,
                            worktree_path,
                            branch_name,
                        ))
                        .map_err(bridge_error_message)
                    })
                })
            })
        }),
        "profile:list" => serde_json::to_value(profile_cmd::profile_list(app.clone()))
            .map_err(|err| format!("remote profile:list serialization failed: {err}")),
        "profile:get-active-ids" => {
            serde_json::to_value(profile_cmd::profile_get_active_ids(app.clone()))
                .map_err(|err| format!("remote profile:get-active-ids serialization failed: {err}"))
        }
        "profile:load-snapshot" => profile_id_from_params(channel, params).map(|profile_id| {
            profile_cmd::profile_load_snapshot_for_remote(app, &profile_id).unwrap_or(Value::Null)
        }),
        "profile:load" => profile_id_from_params(channel, params).map(|profile_id| {
            profile_cmd::profile_load_for_remote(app, &profile_id).unwrap_or(Value::Null)
        }),
        "profile:activate" => profile_id_from_params(channel, params)
            .map(|profile_id| Value::Bool(profile_cmd::activate_profile_id(app, &profile_id))),
        "profile:deactivate" => profile_id_from_params(channel, params)
            .map(|profile_id| Value::Bool(profile_cmd::deactivate_profile_id(app, &profile_id))),
        _ => return None,
    };
    Some(result)
}

fn remote_invoke_timeout(channel: &str) -> Duration {
    match channel {
        "claude:start-session"
        | "claude:resume-session"
        | "claude:send-message"
        | "claude:fork-session" => SESSION_INVOKE_TIMEOUT,
        _ => INVOKE_TIMEOUT,
    }
}

fn channel_to_sidecar_method(channel: &str) -> String {
    let mut out = String::new();
    let mut upper_next = false;
    for ch in channel.replace(':', ".").chars() {
        if ch == '-' {
            upper_next = true;
            continue;
        }
        if upper_next {
            out.extend(ch.to_uppercase());
            upper_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn send_frame<S: io::Read + io::Write>(
    ws: &mut tungstenite::WebSocket<S>,
    frame: Value,
) -> Result<(), String> {
    ws.send(Message::Text(frame.to_string().into()))
        .map_err(|err| format!("remote websocket send failed: {err}"))
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn legacy_event_args(channel: &str, params: &Value) -> Vec<Value> {
    event_params_to_legacy_v1_args(channel, params)
}

#[allow(dead_code)]
fn protocol_name(protocol: RemoteProtocol) -> &'static str {
    match protocol {
        RemoteProtocol::LegacyV1 => REMOTE_PROTOCOL_LEGACY_V1,
        RemoteProtocol::V2 => REMOTE_PROTOCOL_V2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_to_sidecar_method_matches_js_bridge() {
        assert_eq!(
            channel_to_sidecar_method("claude:start-session"),
            "claude.startSession"
        );
        assert_eq!(
            channel_to_sidecar_method("image:read-as-data-url"),
            "image.readAsDataUrl"
        );
        assert_eq!(channel_to_sidecar_method("git:getRoot"), "git.getRoot");
    }

    #[test]
    fn token_and_fingerprint_shapes_match_remote_contract() {
        assert_eq!(generate_token().len(), 32);
        let cert = generate_remote_certificate().expect("cert");
        assert!(cert.cert_der.len() > 100);
        assert!(cert.key_der.len() > 100);
        assert_eq!(fingerprint_sha256(&cert.cert_der).len(), 95);
    }

    #[test]
    fn websocket_accept_key_parses_node_ws_upgrade_request() {
        let request = b"GET / HTTP/1.1\r\n\
            Host: 100.68.234.13:9876\r\n\
            Upgrade: websocket\r\n\
            Connection: Upgrade\r\n\
            Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
            Sec-WebSocket-Version: 13\r\n\
            \r\n";
        assert_eq!(
            websocket_accept_key_from_request(request).as_deref(),
            Ok("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        );
    }

    #[test]
    fn websocket_accept_key_rejects_plain_http_request() {
        let request = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(websocket_accept_key_from_request(request).is_err());
    }

    #[test]
    fn websocket_accept_key_rejects_invalid_key() {
        let request = b"GET / HTTP/1.1\r\n\
            Host: localhost\r\n\
            Upgrade: websocket\r\n\
            Connection: Upgrade\r\n\
            Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==\r\n\
            Sec-WebSocket-Version: 13\r\n\
            \r\n";
        assert!(websocket_accept_key_from_request(request).is_err());
    }

    #[test]
    fn loads_persisted_token_from_node_compatible_plaintext_envelope() {
        let dir = temp_remote_dir("token");
        fs::write(
            dir.join(TOKEN_FILE),
            r#"{"enc":false,"data":"{\"value\":\"persisted-token\"}"}"#,
        )
        .unwrap();
        assert_eq!(
            load_persisted_token(&dir).as_deref(),
            Some("persisted-token")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migrates_legacy_plaintext_server_token() {
        let dir = temp_remote_dir("legacy-token");
        fs::write(dir.join(LEGACY_TOKEN_FILE), r#"{"token":"legacy-token"}"#).unwrap();
        assert_eq!(load_persisted_token(&dir).as_deref(), Some("legacy-token"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ensure_certificate_reuses_node_compatible_plaintext_envelope() {
        let dir = temp_remote_dir("cert");
        let stored = generate_stored_certificate().unwrap();
        let payload = json!({
            "enc": false,
            "data": serde_json::to_string(&stored).unwrap(),
        });
        fs::write(dir.join(CERT_FILE), payload.to_string()).unwrap();

        let cert1 = ensure_remote_certificate(&dir).unwrap();
        let cert2 = ensure_remote_certificate(&dir).unwrap();
        assert_eq!(
            fingerprint_sha256(&cert1.cert_der),
            fingerprint_sha256(&cert2.cert_der)
        );
        assert_eq!(cert1.cert_der, cert2.cert_der);
        let _ = fs::remove_dir_all(dir);
    }

    fn temp_remote_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bat-remote-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
