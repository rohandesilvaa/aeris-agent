use serde::{Deserialize, Serialize};
use std::{
    net::{SocketAddr, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, State};

#[derive(Default)]
struct ServerState(Mutex<Option<Child>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerConfig {
    model_path: String,
    binary_path: String,
    context_size: u32,
    gpu_layers: u32,
    host: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResult {
    pid: Option<u32>,
    already_running: bool,
}

fn port_is_open(host: &str, port: u16) -> bool {
    let Ok(address) = format!("{host}:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

#[tauri::command]
fn start_server(config: ServerConfig, state: State<'_, ServerState>) -> Result<StartResult, String> {
    if config.model_path.trim().is_empty() || !Path::new(&config.model_path).is_file() {
        return Err(format!("Model file not found: {}", config.model_path));
    }

    if port_is_open(&config.host, config.port) {
        return Ok(StartResult { pid: None, already_running: true });
    }

    let mut process = state.0.lock().map_err(|_| "Could not lock server state")?;
    if let Some(child) = process.as_mut() {
        if child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Ok(StartResult { pid: Some(child.id()), already_running: true });
        }
        *process = None;
    }

    let binary = if config.binary_path.trim().is_empty() {
        "llama-server"
    } else {
        config.binary_path.trim()
    };

    let child = Command::new(binary)
        .args([
            "-m",
            &config.model_path,
            "-c",
            &config.context_size.to_string(),
            "-ngl",
            &config.gpu_layers.to_string(),
            "--host",
            &config.host,
            "--port",
            &config.port.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start llama-server at '{binary}': {error}"))?;

    let pid = child.id();
    *process = Some(child);
    Ok(StartResult { pid: Some(pid), already_running: false })
}

#[tauri::command]
fn stop_server(state: State<'_, ServerState>) -> Result<bool, String> {
    let mut process = state.0.lock().map_err(|_| "Could not lock server state")?;
    let Some(mut child) = process.take() else {
        return Ok(false);
    };
    child.kill().map_err(|error| format!("Could not stop llama-server: {error}"))?;
    let _ = child.wait();
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![start_server, stop_server])
        .build(tauri::generate_context!())
        .expect("error while building Aeris Local")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut process) = app.state::<ServerState>().0.lock() {
                    if let Some(mut child) = process.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
