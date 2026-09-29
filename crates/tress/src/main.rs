//! The `tress` binary: a shell-style session in the current directory.

use std::io::{IsTerminal, Write};

use tress::engine::{Approval, Engine, Event};
use tress::provider::Anthropic;
use tress::tools::{NativeTools, Tools};

use commands::Command;

use config::DEFAULT_MODEL;

mod attach;
mod commands;
mod config;
mod connect;
mod host;
mod onboarding;

pub mod ansi {
    pub const DIM: &str = "\x1b[2m";
    pub const BOLD: &str = "\x1b[1m";
    pub const AMBER: &str = "\x1b[33m";
    pub const RED: &str = "\x1b[31m";
    pub const RESET: &str = "\x1b[0m";
}

pub struct Style {
    on: bool,
}

impl Style {
    pub fn paint(&self, code: &str, text: &str) -> String {
        if self.on {
            format!("{code}{text}{}", ansi::RESET)
        } else {
            text.to_owned()
        }
    }
}

fn usage() -> String {
    format!(
        "tress {}\n\n\
         usage:\n  \
         tress setup           connect to a host; use its model credentials\n  \
         tress config          show effective settings (--json for JSON)\n  \
         tress doctor          check setup (--check-api to verify access)\n  \
         tress                 join your saved host and session\n  \
         tress ask <prompt>    send a prompt to the host and exit\n  \
         tress --local        run the standalone agent in this directory\n  \
         tress setup --local  configure your own Anthropic key\n  \
         tress attach -s <id>  join a thread on the saved host\n  \
         tress attach <url>    join a thread with plain terminal output\n  \
         tress attach <url> -s <id>  join your demo session (--session also works)\n  \
         tress attach <url> --ui  opt into the full terminal interface\n  \
         tress connect --site <url> [--root <path>] [--allow-write]\n  \
         tress --help          this text\n\n\
         environment:\n  \
         TRESS_HOST            override the saved host address\n  \
         ANTHROPIC_API_KEY     local mode only; overrides the saved API key\n  \
         TRESS_MODEL           model id (default {DEFAULT_MODEL})\n  \
         TRESS_MAX_STEPS       maximum model requests per turn (default 64)\n  \
         ANTHROPIC_BASE_URL    Anthropic-compatible API endpoint\n\n\
         local options: --model <id>, --max-steps <n>, --base-url <url>\n\
         precedence: flags > environment > .tress.json > personal config > defaults\n",
        env!("CARGO_PKG_VERSION")
    )
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "--help" || arg == "-h")
    {
        print!("{}", usage());
        return std::process::ExitCode::SUCCESS;
    }
    if args
        .first()
        .is_some_and(|arg| arg == "--version" || arg == "-V")
    {
        println!("tress {}", env!("CARGO_PKG_VERSION"));
        return std::process::ExitCode::SUCCESS;
    }

    let style = Style {
        on: std::io::stdout().is_terminal(),
    };

    let root = match std::env::current_dir() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("cannot read the current directory: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let paths = match config::Paths::discover(&root) {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("tress: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    if args.first().is_some_and(|arg| arg == "connect") {
        return match connect::run(&args[1..]).await {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("tress connect: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    if args.first().is_some_and(|arg| arg == "attach") {
        let (url, ui, session) = match attach_options(&args[1..]) {
            Ok(options) => options,
            Err(error) => {
                eprintln!("tress attach: {error}");
                return std::process::ExitCode::FAILURE;
            }
        };
        let target = match host::target(&paths, url, session) {
            Ok(target) => target,
            Err(error) => {
                eprintln!("tress attach: {error}");
                return std::process::ExitCode::FAILURE;
            }
        };
        return match attach::run(&target.host, &style, ui, target.session.as_deref()).await {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{}", style.paint(ansi::RED, &format!("error: {error}")));
                std::process::ExitCode::FAILURE
            }
        };
    }

    if let Some(command @ ("setup" | "config" | "doctor")) = args.first().map(String::as_str) {
        return match onboarding::run(command, &args[1..], &root).await {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("tress {command}: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    let mut selected = config::UserConfig::default();
    let selection = (|| -> Result<bool, String> {
        let rest = config::parse_flags(&args, &mut selected)?;
        if rest.first().is_some_and(|arg| arg == "ask") {
            config::parse_flags(&rest[1..], &mut selected)?;
        }
        config::local_mode(&paths, selected.mode == Some(config::Mode::Local))
    })();
    match selection {
        Ok(false) => {
            return match hosted_session(&args, &paths, &style).await {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("tress: {error}");
                    std::process::ExitCode::FAILURE
                }
            }
        }
        Err(error) => {
            eprintln!("tress: {error}");
            return std::process::ExitCode::FAILURE;
        }
        Ok(true) => {}
    }
    let (flags, one_shot) = match session_options(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("tress: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let settings = match config::Paths::discover(&root)
        .and_then(|paths| config::Resolved::load(&paths, &flags))
        .and_then(|settings| settings.key().map(|_| ()).map(|_| settings))
    {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("tress: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let model = &settings.model.value;
    let mut engine = configured_engine(&settings, &root);

    if let Some(prompt) = one_shot {
        if prompt.trim().is_empty() {
            eprintln!("tress ask: needs a prompt");
            return std::process::ExitCode::FAILURE;
        }
        return match run_turn(&mut engine, &prompt, &style).await {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{}", style.paint(ansi::RED, &format!("error: {error}")));
                std::process::ExitCode::FAILURE
            }
        };
    }

    println!(
        "{} {} {}",
        style.paint(ansi::BOLD, "tress"),
        style.paint(ansi::DIM, env!("CARGO_PKG_VERSION")),
        style.paint(ansi::DIM, &format!("· {} · {}", root.display(), model))
    );
    println!(
        "{}",
        style.paint(ansi::DIM, "/help for commands, ctrl-d to exit")
    );

    loop {
        print!("\n{} ", style.paint(ansi::AMBER, "❯"));
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        match std::io::stdin().read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                eprintln!("input error: {error}");
                break;
            }
        }
        let prompt = line.trim();
        if prompt.is_empty() {
            continue;
        }
        if let Some(command) = commands::parse(prompt) {
            match command {
                Command::Exit => break,
                Command::Help => commands::help(false),
                Command::Files => {
                    let result = engine.tools_mut().execute("ls", &serde_json::json!({}));
                    println!("{}", result.content);
                }
                Command::Status => println!(
                    "Local session\nStatus     idle\nWorkspace  {}\nModel      {model}",
                    root.display()
                ),
                Command::Pwd => println!("{}", root.display()),
                Command::Clear => {
                    engine = configured_engine(&settings, &root);
                    println!(
                        "{}",
                        style.paint(
                            ansi::DIM,
                            "Conversation cleared. Files on disk are unchanged."
                        )
                    );
                }
                Command::Attach | Command::Threads | Command::Disconnect | Command::Reconnect => {
                    println!(
                        "This is a local session. To join a shared host, run: tress attach <url>"
                    );
                }
                Command::Unknown => println!("Unknown command: {prompt}. Type /help for commands."),
            }
            continue;
        }

        if let Err(error) = run_turn(&mut engine, prompt, &style).await {
            eprintln!("{}", style.paint(ansi::RED, &format!("error: {error}")));
        }
    }

    std::process::ExitCode::SUCCESS
}

async fn hosted_session(
    args: &[String],
    paths: &config::Paths,
    style: &Style,
) -> Result<(), String> {
    let mut options = Vec::new();
    let mut rest = args;
    let mut ask = false;
    while let Some(arg) = rest.first() {
        match arg.as_str() {
            "ask" if !ask => { ask = true; rest = &rest[1..]; }
            "--" => { rest = &rest[1..]; break; }
            "--ui" | "--plain" => { options.push(arg.clone()); rest = &rest[1..]; }
            "--host" | "-s" | "--session" => {
                let value = rest.get(1).ok_or_else(|| format!("{arg} needs a value"))?;
                options.extend([arg.clone(), value.clone()]); rest = &rest[2..];
            }
            flag if flag.starts_with('-') => return Err("Hosted sessions use the host's model settings. Use `tress --local` for standalone options; see `tress --help`.".into()),
            _ => break,
        }
    }
    let prompt = (!rest.is_empty()).then(|| rest.join(" "));
    if ask
        && prompt
            .as_ref()
            .is_none_or(|prompt| prompt.trim().is_empty())
    {
        return Err("tress ask needs a prompt".into());
    }
    let (url, ui, session) = attach_options(&options)?;
    let target = host::target(paths, url, session)?;
    match prompt {
        Some(prompt) => attach::ask(&target.host, style, target.session.as_deref(), &prompt).await,
        None => attach::run(&target.host, style, ui, target.session.as_deref()).await,
    }
}

fn configured_engine(
    settings: &config::Resolved,
    root: &std::path::Path,
) -> Engine<Anthropic, NativeTools> {
    Engine::new(
        Anthropic::new(
            settings.key().expect("validated key").to_owned(),
            settings.model.value.clone(),
        )
        .with_base_url(settings.base_url.value.clone()),
        NativeTools::new(root.to_path_buf()),
    )
    .with_max_steps(settings.max_steps.value)
}

fn session_options(args: &[String]) -> Result<(config::UserConfig, Option<String>), String> {
    let mut flags = config::UserConfig::default();
    let mut rest = config::parse_flags(args, &mut flags)?;
    let ask = rest.first().is_some_and(|arg| arg == "ask");
    if ask {
        rest = config::parse_flags(&rest[1..], &mut flags)?;
    }
    if rest.first().is_some_and(|arg| arg == "--") {
        rest = &rest[1..];
    } else if rest.first().is_some_and(|arg| arg.starts_with('-')) {
        return Err(format!("Unknown option {}. See `tress --help`.", rest[0]));
    }
    if rest.is_empty() {
        if ask {
            return Err("tress ask needs a prompt".into());
        }
        return Ok((flags, None));
    }
    Ok((flags, Some(rest.join(" "))))
}

fn attach_options(args: &[String]) -> Result<(Option<&str>, bool, Option<&str>), String> {
    let mut url: Option<&str> = None;
    let mut ui = false;
    let mut plain = false;
    let mut session = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--host" => {
                if url.is_some() {
                    return Err("provide the host only once".into());
                }
                url = Some(args.next().ok_or("--host needs a URL")?.as_str());
            }
            "--ui" => ui = true,
            "--plain" => plain = true, // Keep the earlier explicit plain option working.
            "-s" | "--session" => {
                if session.is_some() {
                    return Err("provide the session ID only once (-s or --session)".into());
                }
                let id = args.next().ok_or_else(|| format!("{arg} needs an ID"))?;
                if !matches!(id.len(), 12 | 32)
                    || !id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                {
                    return Err("invalid session ID; copy the full ID from the site".into());
                }
                session = Some(id.as_str());
            }
            flag if flag.starts_with('-') => return Err(format!("unknown option {flag}")),
            value if url.is_none() => url = Some(value),
            _ => return Err("expected one thread URL".into()),
        }
    }
    if ui && plain {
        return Err("choose --ui or --plain, not both".into());
    }
    Ok((url, ui, session))
}

async fn run_turn(
    engine: &mut Engine<Anthropic, NativeTools>,
    prompt: &str,
    style: &Style,
) -> Result<(), tress::engine::EngineError> {
    let mut at_line_start = true;
    let mut on_event = |event: Event| match event {
        Event::Text(text) => {
            print!("{text}");
            at_line_start = text.ends_with('\n');
            let _ = std::io::stdout().flush();
        }
        Event::ToolStarted { summary, .. } => {
            if !at_line_start {
                println!();
                at_line_start = true;
            }
            println!("{}", style.paint(ansi::DIM, &format!("  · {summary}")));
        }
        Event::ToolFinished { name, is_error } => {
            if is_error {
                println!("{}", style.paint(ansi::RED, &format!("  ✗ {name} failed")));
            }
        }
        Event::ToolDenied { .. } => {
            println!("{}", style.paint(ansi::DIM, "  · denied"));
        }
        Event::ApprovalNeeded { .. } => {}
        Event::Idle => {
            if !at_line_start {
                println!();
            }
        }
    };

    let mut approve = |_name: &str, summary: &str| ask_approval(summary, style);

    engine.send(prompt, &mut on_event, &mut approve).await
}

/// Asks the user about one gated call. A non-terminal stdin denies, so
/// piped runs never block waiting for an answer.
fn ask_approval(summary: &str, style: &Style) -> Approval {
    if !std::io::stdin().is_terminal() {
        println!(
            "{}",
            style.paint(ansi::DIM, "  · denied (no terminal to ask)")
        );
        return Approval::Deny;
    }
    loop {
        print!(
            "{} {} {} ",
            style.paint(ansi::AMBER, "  ●"),
            summary,
            style.paint(ansi::DIM, "[y]es / [a]lways / [n]o")
        );
        let _ = std::io::stdout().flush();
        let mut answer = String::new();
        if std::io::stdin().read_line(&mut answer).is_err() || answer.is_empty() {
            return Approval::Deny;
        }
        match answer.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" | "" => return Approval::Once,
            "a" | "always" => return Approval::Always,
            "n" | "no" => return Approval::Deny,
            _ => continue,
        }
    }
}

#[cfg(test)]
mod cli_tests {
    use super::attach_options;

    #[test]
    fn session_flags_do_not_consume_prompt_text() {
        for args in [
            vec!["--model", "test-model", "ask", "explain", "--model"],
            vec!["ask", "--model", "test-model", "explain", "--model"],
            vec!["--model", "test-model", "explain", "--model"],
        ] {
            let args: Vec<_> = args.into_iter().map(str::to_owned).collect();
            let (flags, prompt) = super::session_options(&args).unwrap();
            assert_eq!(flags.model.as_deref(), Some("test-model"));
            assert_eq!(prompt.as_deref(), Some("explain --model"));
        }
        let args = ["ask", "--", "--literal"].map(str::to_owned);
        assert_eq!(
            super::session_options(&args).unwrap().1.as_deref(),
            Some("--literal")
        );
    }

    #[test]
    fn attach_is_plain_unless_ui_is_explicit() {
        for (args, expected) in [
            (vec!["localhost:5311"], false),
            (vec!["localhost:5311", "--plain"], false),
            (vec!["localhost:5311", "--ui"], true),
            (vec!["--ui", "localhost:5311"], true),
        ] {
            let args: Vec<_> = args.into_iter().map(str::to_owned).collect();
            assert_eq!(
                attach_options(&args),
                Ok((Some("localhost:5311"), expected, None))
            );
        }
    }

    #[test]
    fn invalid_attach_options_fail_before_connecting() {
        for args in [
            vec!["host", "--ui", "--plain"],
            vec!["host", "--other"],
            vec!["one", "two"],
            vec!["host", "--session"],
            vec!["host", "--session", "--ui"],
            vec!["host", "--session", "bad/id"],
            vec!["host", "-s"],
            vec!["host", "-s", "--ui"],
            vec!["host", "-s", "bad/id"],
            vec![
                "host",
                "-s",
                "0123456789abcdef0123456789abcdef",
                "--session",
                "0123456789abcdef0123456789abcdef",
            ],
        ] {
            let args: Vec<_> = args.into_iter().map(str::to_owned).collect();
            assert!(attach_options(&args).is_err());
        }
    }

    #[test]
    fn session_flag_works_with_plain_and_ui_in_any_order() {
        for id in ["Abc1_def-XYZ", "0123456789abcdef0123456789abcdef"] {
            for flag in ["-s", "--session"] {
                for (args, ui) in [
                    (vec!["localhost:5311", flag, id], false),
                    (vec![flag, id, "localhost:5311", "--ui"], true),
                    (vec!["--ui", "localhost:5311", flag, id], true),
                ] {
                    let args: Vec<_> = args.into_iter().map(str::to_owned).collect();
                    assert_eq!(
                        attach_options(&args),
                        Ok((Some("localhost:5311"), ui, Some(id)))
                    );
                }
            }
        }
    }
}
