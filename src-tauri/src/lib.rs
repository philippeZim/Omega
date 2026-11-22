mod fs;
mod spell;
mod latex;
mod latex_guest;
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
mod installs;
mod jdtls;
mod power;
mod instance;
mod lang_shadow;
mod windows;
mod cli;
mod launcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Hands over to a running Omega and exits, or detaches from the terminal.
    let startup = std::sync::Mutex::new(Some(cli::startup()));
    tauri::Builder::default()
        // Links go through env::open_external (native.ts), so the browser gets the user's environment.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(spell::SpellState::default())
        .manage(pty::PtyState::default())
        .manage(proc::ProcState::default())
        .manage(collab::CollabState::default())
        .manage(mcp_control::McpControlState::default())
        .manage(ide_ws::IdeState::default())
        .manage(codex_ipc::CodexState::default())
        .manage(windows::FocusState::default())
        .manage(windows::Registry::default())
        .on_page_load(|webview, payload| {
            use tauri::Manager;
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                collab::frontend_loading(webview.app_handle(), webview.label());
                windows::page_loading(webview.app_handle(), webview.label());
            }
        })
        .on_window_event(|window, event| {
            use tauri::Manager;
            match event {
                tauri::WindowEvent::Focused(true) => windows::focused(window.app_handle(), window.label()),
                tauri::WindowEvent::Destroyed => windows::destroyed(window.app_handle(), window.label()),
                _ => {}
            }
        })
        .setup(move |app| {
            use tauri::Manager;
            let tools = app.path().app_data_dir().map(|d| d.join("tools")).unwrap_or_else(|_| env::home().join(".omega-tools"));
            env::init(tools);
            std::thread::spawn(lang_shadow::sweep_stale);
            // Start the Claude Code IDE server before any terminal spawns (they get its port).
            let h = app.handle().clone();
            if let Err(e) = tauri::async_runtime::block_on(ide_ws::start_server(h)) {
                eprintln!("IDE-Server: {e}");
            }
            codex_ipc::start(app.handle());
            windows::restore(app.handle()).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            if let Some(s) = startup.lock().unwrap().take() {
                cli::begin(app.handle(), s);
            }
            instance::exit_on_signal(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            env::platform_info,
            env::open_external,
            lang_shadow::lang_workdir,
            lang_shadow::lang_copy,
            env::refresh_path,
            tools::tool_install,
            tools::tool_installable,
            tools::golang::go_info,
            installs::installs_status,
            installs::installs_latest,
            installs::installs_remove,
            installs::installs_update_rust,
            installs::installs_system_updates,
            pty::list_shells,
            power::power_keep_awake,
            power::power_status,
            fs::list_dir,
            fs::watch_dir,
            fs::read_file,
            fs::read_file_head,
            fs::read_file_large,
            fs::read_file_view,
            fs::file_info,
            fs::write_file,
            fs::create_file,
            fs::write_file_base64,
            fs::create_dir,
            fs::rename_path,
            fs::delete_path,
            fs::path_exists,
            fs::home_dir,
            fs::list_files,
            search::search_text,
            search::search_cancel,
            search::search_files,
            search::guest_search_text,
            search::guest_search_matching,
            search::guest_list_files,
            search::guest_read_text,
            search::guest_replace_plan,
            search::guest_write_check,
            search::guest_write_text,
            search::guest_search_cancel,
            git::git,
            git::git_status,
            git::git_in_bare_repo,
            git::git_head_file,
            git::git_blame,
            collab::collab_host,
            collab::collab_join,
            collab::collab_send,
            collab::collab_kick,
            collab::collab_stop,
            collab::collab_conn_info,
            collab::collab_path_inside,
            collab::collab_tree_has_git,
            collab::collab_read_bounded,
            collab::collab_hooks_check,
            instance::instance_info,
            launcher::cli_status,
            launcher::cli_install,
            windows::window_new,
            windows::window_open_paths,
            windows::window_boot,
            windows::window_labels,
            windows::windows_unsaved,
            windows::window_unsaved_reply,
            windows::window_relaunch,
            mcp_control::mcp_control_start,
            mcp_control::mcp_control_stop,
            mcp_control::mcp_control_info,
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
            latex_guest::latex_guest_compile,
            latex_guest::latex_guest_cancel,
            latex_guest::collab_read_image,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_write_guest,
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
            proc::mojo_debug_build,
            proc::run_killable,
            proc::run_shared_install,
            proc::install_debugger,
            proc::proc_send,
            proc::proc_kill,
            proc::install_server,
            jdtls::jdtls_runtime,
        ])
        .build({
            let mut ctx = tauri::generate_context!();
            instance::apply(ctx.config_mut());
            ctx
        })
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // Windows closing from here on are part of the quit and stay in the saved session.
                tauri::RunEvent::ExitRequested { .. } => windows::exiting(app),
                tauri::RunEvent::Exit => {
                    ide_ws::cleanup(app);
                    codex_ipc::cleanup(app);
                    power::cleanup();
                    instance::withdraw();
                    lang_shadow::cleanup();
                    cli::cleanup();
                }
                // Finder or `open`: files and folders dropped on the app.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let mut req = cli::Request::default();
                    for p in urls.iter().filter_map(|u| u.to_file_path().ok()).filter_map(|p| p.to_str().map(str::to_string)) {
                        if std::path::Path::new(&p).is_dir() { req.dirs.push(p) } else { req.files.push(p) }
                    }
                    windows::route(app, cli::validated(req), false);
                }
                _ => {}
            }
        });
}
