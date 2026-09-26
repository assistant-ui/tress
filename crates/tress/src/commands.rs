//! Commands handled by the client, without asking the model.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Help,
    Files,
    Pwd,
    Threads,
    Status,
    Clear,
    Attach,
    Disconnect,
    Reconnect,
    Exit,
    Unknown,
}

pub struct CommandInfo {
    pub name: &'static str,
    pub description: &'static str,
    pub attached_only: bool,
}

pub const COMMANDS: &[CommandInfo] = &[
    CommandInfo {
        name: "/help",
        description: "show commands",
        attached_only: false,
    },
    CommandInfo {
        name: "/files",
        description: "show workspace files",
        attached_only: false,
    },
    CommandInfo {
        name: "/pwd",
        description: "show the local workspace path",
        attached_only: false,
    },
    CommandInfo {
        name: "/status",
        description: "show connection, clients, workspace, and runs",
        attached_only: false,
    },
    CommandInfo {
        name: "/threads",
        description: "switch recent terminal threads (ctrl-t)",
        attached_only: true,
    },
    CommandInfo {
        name: "/attach",
        description: "show this thread's attach command",
        attached_only: true,
    },
    CommandInfo {
        name: "/disconnect",
        description: "disconnect; the host keeps running",
        attached_only: true,
    },
    CommandInfo {
        name: "/reconnect",
        description: "rejoin and catch up with the thread",
        attached_only: true,
    },
    CommandInfo {
        name: "/clear",
        description: "clear conversation; local and remote files stay",
        attached_only: false,
    },
    CommandInfo {
        name: "/exit",
        description: "leave the terminal (/quit or ctrl-d)",
        attached_only: false,
    },
];

pub fn matching(query: &str) -> Vec<&'static CommandInfo> {
    let query = query.trim().to_ascii_lowercase();
    COMMANDS
        .iter()
        .filter(|item| item.name.starts_with(&query))
        .collect()
}

pub fn parse(input: &str) -> Option<Command> {
    let input = input.trim();
    if !input.starts_with('/') {
        return None;
    }
    Some(match input.to_ascii_lowercase().as_str() {
        "/" | "/help" => Command::Help,
        "/files" => Command::Files,
        "/pwd" => Command::Pwd,
        "/threads" => Command::Threads,
        "/status" => Command::Status,
        "/clear" => Command::Clear,
        "/attach" => Command::Attach,
        "/disconnect" => Command::Disconnect,
        "/reconnect" => Command::Reconnect,
        "/exit" | "/quit" => Command::Exit,
        _ => Command::Unknown,
    })
}

pub fn help(attached: bool) {
    for item in COMMANDS
        .iter()
        .filter(|item| attached || !item.attached_only)
    {
        println!("  {:<13} {}", item.name, item.description);
    }
    if attached {
        println!("  Memory workspaces restore their example files on /clear.");
    }
}

#[cfg(test)]
mod tests {
    use super::{parse, Command};

    #[test]
    fn commands_are_trimmed_and_case_insensitive() {
        assert_eq!(parse(" /FiLeS \n"), Some(Command::Files));
        assert_eq!(parse("/"), Some(Command::Help));
        assert_eq!(parse("/quit"), Some(Command::Exit));
        assert_eq!(parse(" /PWD "), Some(Command::Pwd));
    }

    #[test]
    fn unknown_or_incomplete_commands_never_become_prompts() {
        for input in ["/unknown", "/cl", "/clear all", "/help me"] {
            assert_eq!(parse(input), Some(Command::Unknown));
        }
        assert_eq!(parse("please read /src/main.rs"), None);
        assert_eq!(parse(""), None);
    }
}
