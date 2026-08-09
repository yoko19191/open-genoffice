mod command_line;

const USAGE_EXIT_CODE: i32 = 64;
const CRASH_EXIT_CODE: i32 = 70;

fn parse_args(args: &[String]) -> Result<(u32, &str, &[String]), ()> {
    if args.len() < 5 || args[0] != "--owner-pid" || args[2] != "--" {
        return Err(());
    }
    let owner_pid = args[1].parse::<u32>().map_err(|_| ())?;
    if owner_pid == 0 || args[3].is_empty() {
        return Err(());
    }
    Ok((owner_pid, &args[3], &args[4..]))
}

#[cfg(windows)]
mod windows_job;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--version"] {
        println!("open-genoffice-job-launcher 0.1.0");
        return;
    }
    let Ok((owner_pid, executable, runtime_args)) = parse_args(&args) else {
        eprintln!("job_launcher_arguments_invalid");
        std::process::exit(USAGE_EXIT_CODE);
    };

    #[cfg(windows)]
    match windows_job::run(owner_pid, executable, runtime_args) {
        Ok(exit_code) => std::process::exit(exit_code as i32),
        Err(()) => {
            eprintln!("job_launcher_failed");
            std::process::exit(CRASH_EXIT_CODE);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (owner_pid, executable, runtime_args);
        eprintln!("job_launcher_platform_unsupported");
        std::process::exit(CRASH_EXIT_CODE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_an_explicit_nonzero_owner_and_target() {
        let valid = vec![
            "--owner-pid".to_owned(),
            "42".to_owned(),
            "--".to_owned(),
            "runtime.exe".to_owned(),
            "entry.mjs".to_owned(),
        ];
        assert_eq!(parse_args(&valid), Ok((42, "runtime.exe", &valid[4..])));

        for invalid in [
            vec![],
            vec!["--owner-pid", "0", "--", "runtime.exe", "entry.mjs"],
            vec!["--owner-pid", "text", "--", "runtime.exe", "entry.mjs"],
            vec!["--owner-pid", "42", "runtime.exe", "entry.mjs", "extra"],
            vec!["--owner-pid", "42", "--", "", "entry.mjs"],
        ] {
            let values = invalid.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert_eq!(parse_args(&values), Err(()));
        }
    }
}
