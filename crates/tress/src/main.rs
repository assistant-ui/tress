//! The `tress` binary: a shell-style session in the current directory.

use std::io::{IsTerminal, Write};

use tress::engine::{Approval, Engine, Event};
use tress::provider::Anthropic;
use tress::tools::NativeTools;

const DEFAULT_MODEL: &str = "claude-sonnet-5";

mod attach;

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
         tress                 start a session in the current directory\n  \
         tress ask <prompt>    run one prompt and exit\n  \
         tress attach <url>    join a thread and follow it live\n  \
         tress --help          this text\n\n\
         environment:\n  \
         ANTHROPIC_API_KEY     required\n  \
         TRESS_MODEL           model id (default {DEFAULT_MODEL})\n",
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

    if args.first().is_some_and(|arg| arg == "attach") {
        let Some(url) = args.get(1) else {
            eprintln!("tress attach: needs a thread url");
            return std::process::ExitCode::FAILURE;
        };
        return match attach::run(url, &style).await {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{}", style.paint(ansi::RED, &format!("error: {error}")));
                std::process::ExitCode::FAILURE
            }
        };
    }

    let Ok(api_key) = std::env::var("ANTHROPIC_API_KEY") else {
        eprintln!(
            "{}",
            style.paint(ansi::RED, "ANTHROPIC_API_KEY is not set.")
        );
        eprintln!("Export a key, then run tress again.");
        return std::process::ExitCode::FAILURE;
    };
    let model = std::env::var("TRESS_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
    let root = match std::env::current_dir() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("cannot read the current directory: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let mut engine = Engine::new(
        Anthropic::new(api_key, model.clone()),
        NativeTools::new(root.clone()),
    );

    let one_shot = match args.first().map(String::as_str) {
        Some("ask") => Some(args[1..].join(" ")),
        Some(other) if !other.starts_with('-') => Some(args.join(" ")),
        _ => None,
    };

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
        match prompt {
            "" => continue,
            "/exit" | "/quit" => break,
            "/help" => {
                println!("  /help   this text");
                println!("  /clear  start a fresh conversation");
                println!("  /exit   leave (ctrl-d works too)");
                continue;
            }
            "/clear" => {
                engine = Engine::new(
                    Anthropic::new(
                        std::env::var("ANTHROPIC_API_KEY").unwrap_or_default(),
                        model.clone(),
                    ),
                    NativeTools::new(root.clone()),
                );
                println!("{}", style.paint(ansi::DIM, "cleared"));
                continue;
            }
            _ => {}
        }

        if let Err(error) = run_turn(&mut engine, prompt, &style).await {
            eprintln!("{}", style.paint(ansi::RED, &format!("error: {error}")));
        }
    }

    std::process::ExitCode::SUCCESS
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
