// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if better_agent_terminal_lib::is_headless_server_invocation() {
        std::process::exit(better_agent_terminal_lib::run_headless_server_cli());
    }
    better_agent_terminal_lib::run();
}
