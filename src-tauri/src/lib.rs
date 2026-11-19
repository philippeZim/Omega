mod fs;
mod spell;
mod latex;
mod pty;
mod proc;
mod search;
mod git;
mod collab;
mod mcp_control;
mod ide_ws;
mod codex_ipc;
mod env;
mod tools;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(spell::SpellState::default())
        .manage(pty::PtyState::default())
        .manage(proc::ProcState::default())
        .manage(collab::CollabState::default())
        .manage(mcp_control::McpControlState::default())
        .manage(ide_ws::IdeState::default())
        .manage(codex_ipc::CodexState::default())
        .setup(|app| {
            use tauri::Manager;
            let tools = app.path().app_data_dir().map(|d| d.join("tools")).unwrap_or_else(|_| env::home().join(".studio-tools"));
            env::init(tools);
            // Start the Claude Code IDE server before any terminal spawns (they get its port).
            let h = app.handle().clone();
            if let Err(e) = tauri::async_runtime::block_on(ide_ws::ide_start(h, serde_json::json!([]), vec![])) {
                eprintln!("IDE-Server: {e}");
            }
            codex_ipc::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            env::platform_info,
            env::refresh_path,
            tools::tool_install,
            tools::tool_installable,
            fs::list_dir,
            fs::read_file,
            fs::write_file,
            fs::create_dir,
            fs::rename_path,
            fs::delete_path,
            fs::path_exists,
            fs::home_dir,
            fs::cli_paths,
            fs::list_files,
            search::search_text,
            search::search_cancel,
            git::git,
            git::git_status,
            git::git_head_file,
            collab::collab_host,
            collab::collab_join,
            collab::collab_send,
            collab::collab_kick,
            collab::collab_stop,
            collab::collab_conn_info,
            mcp_control::mcp_control_start,
            mcp_control::mcp_control_stop,
            mcp_control::mcp_reply,
            ide_ws::ide_start,
            ide_ws::ide_set_folders,
            ide_ws::ide_reply,
            ide_ws::ide_notify,
            ide_ws::ide_info,
            codex_ipc::codex_set_context,
            codex_ipc::codex_status,
            spell::spell_check,
            spell::spell_suggest,
            spell::spell_add,
            latex::latex_available,
            latex::latex_compile,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            proc::which_cmd,
            proc::cmd_works,
            proc::tools_dir,
            proc::proc_spawn,
            proc::proc_spawn_tcp,
            proc::proc_connect,
            proc::run_capture,
            proc::install_debugger,
            proc::proc_send,
            proc::proc_kill,
            proc::install_server,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                ide_ws::cleanup(app);
                codex_ipc::cleanup(app);
            }
        });
}
