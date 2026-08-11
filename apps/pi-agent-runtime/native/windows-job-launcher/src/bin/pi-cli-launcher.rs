use std::path::{Path, PathBuf};
use std::process::Command;

const CRASH_EXIT_CODE: i32 = 70;

fn entry_path(executable: &Path, smoke_override: bool) -> Option<PathBuf> {
    let node_dir = executable.parent()?;
    let file_name = executable
        .file_name()?
        .to_string_lossy()
        .to_ascii_lowercase();
    let relative = if smoke_override || file_name.contains("smoke") {
        ["..", "self-test", "pi-headless-fixture.mjs"]
    } else {
        ["..", "app", "pi-cli.mjs"]
    };
    Some(
        relative
            .iter()
            .fold(node_dir.to_path_buf(), |path, part| path.join(part)),
    )
}

fn run() -> Result<i32, ()> {
    let executable = std::env::current_exe().map_err(|_| ())?;
    let node_dir = executable.parent().ok_or(())?;
    let node = node_dir.join("open-genoffice-pi-agent-runtime.exe");
    let smoke_override = std::env::var("GENOFFICE_PI_SMOKE").as_deref() == Ok("1");
    let entry = entry_path(&executable, smoke_override).ok_or(())?;
    let status = Command::new(node)
        .arg(entry)
        .args(std::env::args_os().skip(1))
        .status()
        .map_err(|_| ())?;
    Ok(status.code().unwrap_or(CRASH_EXIT_CODE))
}

fn main() {
    match run() {
        Ok(exit_code) => std::process::exit(exit_code),
        Err(()) => {
            eprintln!("pi_cli_launcher_failed");
            std::process::exit(CRASH_EXIT_CODE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_the_packaged_pi_or_smoke_entry_from_its_own_name() {
        assert_eq!(
            entry_path(Path::new("C:/bundle/node/open-genoffice-pi-cli.exe"), false),
            Some(PathBuf::from("C:/bundle/node/../app/pi-cli.mjs")),
        );
        assert_eq!(
            entry_path(
                Path::new("C:/bundle/node/open-genoffice-pi-smoke.exe"),
                false
            ),
            Some(PathBuf::from(
                "C:/bundle/node/../self-test/pi-headless-fixture.mjs",
            )),
        );
        assert_eq!(
            entry_path(Path::new("C:/bundle/node/pi.exe"), true),
            Some(PathBuf::from(
                "C:/bundle/node/../self-test/pi-headless-fixture.mjs",
            )),
        );
        assert_eq!(
            entry_path(Path::new("open-genoffice-pi-cli.exe"), false),
            Some(PathBuf::from("../app/pi-cli.mjs")),
        );
    }
}
