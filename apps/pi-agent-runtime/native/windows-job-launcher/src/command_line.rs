use std::path::Path;

pub fn quote_arg(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|character| matches!(character, ' ' | '\t' | '"' | '\\'))
    {
        return value.to_owned();
    }

    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => {
                backslashes += 1;
                quoted.push('\\');
            }
            '"' => {
                for _ in 0..backslashes {
                    quoted.push('\\');
                }
                quoted.push('\\');
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                quoted.push(character);
            }
        }
    }
    for _ in 0..backslashes {
        quoted.push('\\');
    }
    quoted.push('"');
    quoted
}

pub fn build_command_line(executable: &Path, args: &[String]) -> String {
    let mut command_line = quote_arg(&executable.display().to_string());
    for argument in args {
        command_line.push(' ');
        command_line.push_str(&quote_arg(argument));
    }
    command_line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_empty_whitespace_and_plain_arguments() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("two words"), "\"two words\"");
    }

    #[test]
    fn preserves_backslashes_around_quotes_and_at_the_end() {
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_arg(r"a\"), r#""a\\""#);
        assert_eq!(quote_arg(r"a\\"), r#""a\\\\""#);
    }

    #[test]
    fn builds_a_reversible_runtime_command_line() {
        assert_eq!(
            build_command_line(
                Path::new(r"C:\Program Files\Open GenOffice\runtime.exe"),
                &["entry.mjs".to_owned(), "two words".to_owned()],
            ),
            r#""C:\Program Files\Open GenOffice\runtime.exe" entry.mjs "two words""#,
        );
    }
}
