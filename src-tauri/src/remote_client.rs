use crate::commands::pty as pty_cmd;
use crate::event_hub::publish_runtime_event;
use crate::remote_core::{
    canonical_remote_channel, decode_remote_binary_frame, decode_remote_text_frame,
    encode_remote_frame, is_proxied_remote_event, legacy_v1_event_args_to_params,
    RemoteCompression, RemoteFramePayload, REMOTE_COMPRESSION_GZIP, REMOTE_PROTOCOL_LEGACY_V1,
    REMOTE_PROTOCOL_V2,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tungstenite::client::IntoClientRequest;
use tungstenite::protocol::WebSocket;
use tungstenite::Message;

const AUTH_TIMEOUT: Duration = Duration::from_secs(6);
const INVOKE_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_TIMEOUT: Duration = Duration::from_millis(100);
const CLIENT_DEVICE_ID_FILE: &str = "remote-client-id.json";

type RemoteWebSocket = WebSocket<StreamOwned<ClientConnection, TcpStream>>;

#[derive(Clone, Default)]
pub struct RustRemoteClientState {
    inner: Arc<Mutex<Option<RunningClient>>>,
    next_id: Arc<AtomicU64>,
}

struct RunningClient {
    host: String,
    port: u16,
    compression: RemoteCompression,
    connected: Arc<AtomicBool>,
    tx: mpsc::Sender<ClientCommand>,
}

enum ClientCommand {
    Invoke {
        id: String,
        channel: String,
        args: Vec<Value>,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    Disconnect,
}

struct PendingInvoke {
    channel: String,
    deadline: Instant,
    reply: mpsc::Sender<Result<Value, String>>,
}

struct RemoteConnection {
    ws: RemoteWebSocket,
    protocol: String,
    compression: RemoteCompression,
}

#[derive(Debug)]
struct AllowAnyServerCertificate;

impl ServerCertVerifier for AllowAnyServerCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

impl RustRemoteClientState {
    pub fn connect(
        &self,
        app: AppHandle,
        host: String,
        port: u16,
        token: String,
        fingerprint: String,
        label: Option<String>,
        window_id: Option<String>,
    ) -> Result<Value, String> {
        validate_connection_fields(&host, port, &token, &fingerprint)?;
        let label = label
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(default_client_label);
        self.disconnect();
        let device_id = load_or_create_client_device_id(&app);
        let connection = connect_socket(
            &host,
            port,
            &token,
            &fingerprint,
            &label,
            window_id,
            device_id,
        )?;
        let compression = connection.compression;
        let protocol = connection.protocol.clone();
        let (tx, rx) = mpsc::channel();
        let connected = Arc::new(AtomicBool::new(true));
        let connected_for_loop = Arc::clone(&connected);
        thread::spawn(move || client_loop(app, connection.ws, rx, connected_for_loop, compression));
        let info = json!({ "host": host, "port": port, "compression": compression.as_str() });
        let running = RunningClient {
            host: info["host"].as_str().unwrap_or_default().to_string(),
            port,
            compression,
            connected,
            tx,
        };
        *self.inner.lock().expect("remote client lock") = Some(running);
        Ok(json!({ "connected": true, "info": info, "protocol": protocol }))
    }

    pub fn disconnect(&self) -> bool {
        let running = self.inner.lock().expect("remote client lock").take();
        if let Some(client) = running {
            client.connected.store(false, Ordering::SeqCst);
            let _ = client.tx.send(ClientCommand::Disconnect);
            true
        } else {
            false
        }
    }

    pub fn status(&self) -> Value {
        let guard = self.inner.lock().expect("remote client lock");
        let Some(client) = guard.as_ref() else {
            return json!({ "connected": false, "info": null });
        };
        let connected = client.connected.load(Ordering::SeqCst);
        json!({
            "connected": connected,
            "info": if connected {
                json!({
                    "host": client.host,
                    "port": client.port,
                    "compression": client.compression.as_str(),
                })
            } else {
                Value::Null
            },
        })
    }

    pub fn invoke(
        &self,
        channel: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        if channel.trim().is_empty() {
            return Err("remote.invoke: channel is required".to_string());
        }
        let (tx, connected) = {
            let guard = self.inner.lock().expect("remote client lock");
            let Some(client) = guard.as_ref() else {
                return Err("remote.invoke: not connected to remote server".to_string());
            };
            (client.tx.clone(), client.connected.load(Ordering::SeqCst))
        };
        if !connected {
            return Err("remote.invoke: not connected to remote server".to_string());
        }
        let id = self.next_id();
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(ClientCommand::Invoke {
            id,
            channel: channel.to_string(),
            args,
            reply: reply_tx,
        })
        .map_err(|_| "remote.invoke: connection closed".to_string())?;
        reply_rx
            .recv_timeout(timeout)
            .map_err(|_| format!("Remote invoke timeout: {channel}"))?
    }

    pub fn test_connection(
        &self,
        host: String,
        port: u16,
        token: String,
        fingerprint: String,
    ) -> Result<Value, String> {
        validate_connection_fields(&host, port, &token, &fingerprint)?;
        let mut connection = connect_socket(
            &host,
            port,
            &token,
            &fingerprint,
            &default_client_label(),
            None,
            None,
        )?;
        let _ = connection.ws.close(None);
        Ok(json!({ "ok": true }))
    }

    pub fn list_profiles(
        &self,
        host: String,
        port: u16,
        token: String,
        fingerprint: String,
    ) -> Result<Value, String> {
        validate_connection_fields(&host, port, &token, &fingerprint)?;
        let mut connection = connect_socket(
            &host,
            port,
            &token,
            &fingerprint,
            &default_client_label(),
            None,
            None,
        )?;
        let result = invoke_socket(
            &mut connection.ws,
            connection.compression,
            "profile:list",
            Vec::new(),
            INVOKE_TIMEOUT,
        )?;
        let _ = connection.ws.close(None);
        let profiles = result
            .get("profiles")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .map(|profile| {
                        json!({
                            "id": profile.get("id").cloned().unwrap_or(Value::Null),
                            "name": profile.get("name").cloned().unwrap_or(Value::Null),
                            "type": profile.get("type").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let active_profile_ids = result
            .get("activeProfileIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(json!({ "profiles": profiles, "activeProfileIds": active_profile_ids }))
    }

    fn next_id(&self) -> String {
        let seq = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        format!("{}-{seq}", unix_ms())
    }
}

fn client_loop(
    app: AppHandle,
    mut ws: RemoteWebSocket,
    rx: mpsc::Receiver<ClientCommand>,
    connected: Arc<AtomicBool>,
    compression: RemoteCompression,
) {
    let mut pending: HashMap<String, PendingInvoke> = HashMap::new();
    loop {
        while let Ok(command) = rx.try_recv() {
            match command {
                ClientCommand::Disconnect => {
                    let _ = ws.close(None);
                    connected.store(false, Ordering::SeqCst);
                    drain_pending(&mut pending, "Disconnected");
                    return;
                }
                ClientCommand::Invoke {
                    id,
                    channel,
                    args,
                    reply,
                } => {
                    log_remote_pty_write_args(&app, "remote-client.send", &channel, &args);
                    let frame =
                        json!({ "type": "invoke", "id": id, "channel": channel, "args": args });
                    match send_json_frame(&mut ws, frame, compression) {
                        Ok(()) => {
                            pending.insert(
                                id,
                                PendingInvoke {
                                    channel,
                                    deadline: Instant::now() + INVOKE_TIMEOUT,
                                    reply,
                                },
                            );
                        }
                        Err(err) => {
                            let _ = reply.send(Err(err));
                        }
                    }
                }
            }
        }

        expire_pending(&mut pending);
        match ws.read() {
            Ok(Message::Text(text)) if compression == RemoteCompression::None => {
                if let Ok(frame) = decode_remote_text_frame(&text) {
                    handle_frame(&app, &mut pending, frame);
                }
            }
            Ok(Message::Binary(bytes)) if compression == RemoteCompression::Gzip => {
                if let Ok(frame) = decode_remote_binary_frame(&bytes) {
                    handle_frame(&app, &mut pending, frame);
                }
            }
            Ok(Message::Ping(bytes)) => {
                let _ = ws.send(Message::Pong(bytes));
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    connected.store(false, Ordering::SeqCst);
    drain_pending(&mut pending, "Connection closed");
}

fn log_remote_pty_write_args(app: &AppHandle, phase: &str, channel: &str, args: &[Value]) {
    if canonical_remote_channel(channel) != "pty:write" {
        return;
    }
    let Some(id) = args.first().and_then(Value::as_str) else {
        return;
    };
    let Some(data) = args.get(1).and_then(Value::as_str) else {
        return;
    };
    if !pty_cmd::pty_input_trace_required(data) {
        return;
    }
    pty_cmd::pty_input_debug_log(
        app,
        format!("{phase} id={id} {}", pty_cmd::describe_pty_input(data)),
    );
}

fn handle_frame(app: &AppHandle, pending: &mut HashMap<String, PendingInvoke>, frame: Value) {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    if matches!(frame_type, "invoke-result" | "invoke-error") {
        let Some(id) = frame.get("id").and_then(Value::as_str) else {
            return;
        };
        if let Some(pending) = pending.remove(id) {
            let result = if frame_type == "invoke-error" {
                Err(frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Remote invoke failed")
                    .to_string())
            } else {
                Ok(frame.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = pending.reply.send(result);
        }
        return;
    }
    if frame_type == "event" {
        let Some(raw_channel) = frame.get("channel").and_then(Value::as_str) else {
            return;
        };
        let channel = canonical_remote_channel(raw_channel);
        if !is_proxied_remote_event(&channel) {
            return;
        }
        let params = frame.get("params").cloned().unwrap_or_else(|| {
            let args = frame
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            legacy_v1_event_args_to_params(&channel, &args)
        });
        publish_runtime_event(app, &channel, params, "rust-remote-client");
    }
}

fn expire_pending(pending: &mut HashMap<String, PendingInvoke>) {
    let now = Instant::now();
    let expired = pending
        .iter()
        .filter_map(|(id, pending)| (pending.deadline <= now).then_some(id.clone()))
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(pending) = pending.remove(&id) {
            let _ = pending
                .reply
                .send(Err(format!("Remote invoke timeout: {}", pending.channel)));
        }
    }
}

fn drain_pending(pending: &mut HashMap<String, PendingInvoke>, message: &str) {
    for (_, pending) in pending.drain() {
        let _ = pending.reply.send(Err(message.to_string()));
    }
}

fn generate_client_device_id() -> String {
    let bytes = rand::random::<[u8; 16]>();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// A stable per-install identifier sent to the host as `clientInfo.deviceId`.
// The host uses it to recognize this client on reconnect, so it only shows a
// "new client connected" notification the first time this install connects.
// Generated once and persisted under the app data dir.
fn load_or_create_client_device_id(app: &AppHandle) -> Option<String> {
    let data_dir = crate::app_data::app_data_dir(app).ok()?;
    let path = data_dir.join(CLIENT_DEVICE_ID_FILE);
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Some(existing) = serde_json::from_str::<Value>(&raw)
            .ok()
            .as_ref()
            .and_then(|value| value.get("deviceId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
        {
            return Some(existing);
        }
    }
    let id = generate_client_device_id();
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = std::fs::write(&path, json!({ "deviceId": id }).to_string());
    Some(id)
}

fn connect_socket(
    host: &str,
    port: u16,
    token: &str,
    fingerprint: &str,
    label: &str,
    window_id: Option<String>,
    device_id: Option<String>,
) -> Result<RemoteConnection, String> {
    let pinned_fingerprint = normalize_fingerprint(fingerprint);
    if pinned_fingerprint.is_empty() {
        return Err("fingerprint is required for TLS pinning".to_string());
    }
    let tcp = TcpStream::connect((host, port))
        .map_err(|err| format!("remote TCP connect failed: {err}"))?;
    tcp.set_read_timeout(Some(AUTH_TIMEOUT))
        .map_err(|err| format!("remote TCP timeout failed: {err}"))?;
    tcp.set_write_timeout(Some(AUTH_TIMEOUT))
        .map_err(|err| format!("remote TCP write timeout failed: {err}"))?;

    let mut connection = ClientConnection::new(build_client_config()?, server_name_for(host)?)
        .map_err(|err| format!("remote TLS setup failed: {err}"))?;
    let mut tcp_for_handshake = tcp;
    while connection.is_handshaking() {
        connection
            .complete_io(&mut tcp_for_handshake)
            .map_err(|err| format!("remote TLS handshake failed: {err}"))?;
    }
    let peer_fingerprint = connection
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|cert| fingerprint_sha256(cert.as_ref()))
        .unwrap_or_default();
    if normalize_fingerprint(&peer_fingerprint) != pinned_fingerprint {
        return Err(format!(
            "fingerprint mismatch: expected {}, got {}",
            summarize_fingerprint(&pinned_fingerprint),
            summarize_fingerprint(&peer_fingerprint)
        ));
    }

    tcp_for_handshake
        .set_read_timeout(Some(POLL_TIMEOUT))
        .map_err(|err| format!("remote stream polling timeout failed: {err}"))?;
    let tls = StreamOwned::new(connection, tcp_for_handshake);
    let request = format!("wss://{host}:{port}/")
        .into_client_request()
        .map_err(|err| format!("remote websocket request failed: {err}"))?;
    let (mut ws, _) = tungstenite::client(request, tls)
        .map_err(|err| format!("remote websocket connect failed: {err}"))?;
    let mut client_info = json!({
        "appName": "Better Agent Terminal Desktop",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "deviceName": label,
        "label": label,
        "platform": std::env::consts::OS,
    });
    // The host dedups "new client" notifications on this stable id.
    if let Some(id) = device_id.as_deref().filter(|id| !id.is_empty()) {
        client_info["deviceId"] = json!(id);
    }
    send_json_frame(
        &mut ws,
        json!({
            "type": "auth",
            "id": format!("{}-auth", unix_ms()),
            "token": token,
            "protocols": [REMOTE_PROTOCOL_V2, REMOTE_PROTOCOL_LEGACY_V1],
            "compression": [REMOTE_COMPRESSION_GZIP],
            "args": [label, { "windowId": window_id, "clientInfo": client_info }],
        }),
        RemoteCompression::None,
    )?;
    let deadline = Instant::now() + AUTH_TIMEOUT;
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if frame.get("type").and_then(Value::as_str) != Some("auth-result") {
                    continue;
                }
                if let Some(error) = frame.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                let protocol = frame
                    .get("protocol")
                    .and_then(Value::as_str)
                    .unwrap_or(REMOTE_PROTOCOL_LEGACY_V1)
                    .to_string();
                let compression = match frame.get("compression").and_then(Value::as_str) {
                    Some(REMOTE_COMPRESSION_GZIP) => RemoteCompression::Gzip,
                    _ => RemoteCompression::None,
                };
                return Ok(RemoteConnection {
                    ws,
                    protocol,
                    compression,
                });
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    return Err("remote auth timed out".to_string());
                }
            }
            Err(err) => return Err(format!("remote auth failed: {err}")),
        }
    }
}

fn invoke_socket(
    ws: &mut RemoteWebSocket,
    compression: RemoteCompression,
    channel: &str,
    args: Vec<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let id = format!("{}-invoke", unix_ms());
    send_json_frame(
        ws,
        json!({ "type": "invoke", "id": id, "channel": channel, "args": args }),
        compression,
    )?;
    let deadline = Instant::now() + timeout;
    loop {
        match ws.read() {
            Ok(Message::Text(text)) if compression == RemoteCompression::None => {
                let Ok(frame) = decode_remote_text_frame(&text) else {
                    continue;
                };
                if frame.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                    continue;
                }
                match frame.get("type").and_then(Value::as_str) {
                    Some("invoke-result") => {
                        return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Some("invoke-error") => {
                        return Err(frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Remote invoke failed")
                            .to_string());
                    }
                    _ => {}
                }
            }
            Ok(Message::Binary(bytes)) if compression == RemoteCompression::Gzip => {
                let Ok(frame) = decode_remote_binary_frame(&bytes) else {
                    continue;
                };
                if frame.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                    continue;
                }
                match frame.get("type").and_then(Value::as_str) {
                    Some("invoke-result") => {
                        return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Some("invoke-error") => {
                        return Err(frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Remote invoke failed")
                            .to_string());
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(err))
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                if Instant::now() >= deadline {
                    return Err(format!("Remote invoke timeout: {channel}"));
                }
            }
            Err(err) => return Err(format!("Remote invoke failed: {err}")),
        }
    }
}

fn build_client_config() -> Result<Arc<ClientConfig>, String> {
    let provider = rustls::crypto::ring::default_provider();
    let config = ClientConfig::builder_with_provider(provider.into())
        .with_safe_default_protocol_versions()
        .map_err(|err| format!("remote TLS protocol config failed: {err:?}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AllowAnyServerCertificate))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

fn server_name_for(host: &str) -> Result<ServerName<'static>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ServerName::IpAddress(ip.into()));
    }
    ServerName::try_from(host.to_string()).map_err(|_| "remote host is not a valid DNS name".into())
}

fn send_json_frame(
    ws: &mut RemoteWebSocket,
    frame: Value,
    compression: RemoteCompression,
) -> Result<(), String> {
    match encode_remote_frame(&frame, compression)? {
        RemoteFramePayload::Text(text) => ws.send(Message::Text(text.into())),
        RemoteFramePayload::Binary(bytes) => ws.send(Message::Binary(bytes.into())),
    }
    .map_err(|err| format!("remote websocket send failed: {err}"))
}

fn validate_connection_fields(
    host: &str,
    port: u16,
    token: &str,
    fingerprint: &str,
) -> Result<(), String> {
    if host.trim().is_empty() || port == 0 || token.trim().is_empty() {
        return Err("host, port, and token are required".to_string());
    }
    if fingerprint.trim().is_empty() {
        return Err("fingerprint is required".to_string());
    }
    Ok(())
}

fn default_client_label() -> String {
    let suffix = unix_ms() % 1_000_000;
    format!("Client-{suffix:06}")
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn fingerprint_sha256(cert_der: &[u8]) -> String {
    let digest = Sha256::digest(cert_der);
    digest
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn normalize_fingerprint(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .map(|ch| ch.to_ascii_uppercase())
        .collect::<Vec<_>>()
        .chunks(2)
        .filter(|chunk| chunk.len() == 2)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(":")
}

fn summarize_fingerprint(value: &str) -> String {
    let normalized = normalize_fingerprint(value);
    if normalized.len() <= 23 {
        normalized
    } else {
        format!("{}...", &normalized[..23])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_fingerprint_like_node_client() {
        assert_eq!(
            normalize_fingerprint("aa bb:cc-dd"),
            "AA:BB:CC:DD".to_string()
        );
        assert_eq!(summarize_fingerprint("AA:BB").as_str(), "AA:BB");
    }

    #[test]
    fn validates_remote_connection_fields() {
        assert!(validate_connection_fields("localhost", 9876, "token", "AA").is_ok());
        assert!(validate_connection_fields("", 9876, "token", "AA").is_err());
        assert!(validate_connection_fields("localhost", 0, "token", "AA").is_err());
        assert!(validate_connection_fields("localhost", 9876, "", "AA").is_err());
        assert!(validate_connection_fields("localhost", 9876, "token", "").is_err());
    }
}
