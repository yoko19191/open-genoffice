use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::path::Path;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess, OpenProcess, PROCESS_INFORMATION,
    PROCESS_SYNCHRONIZE_RIGHTS, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOW, SYNCHRONIZE,
    TerminateProcess, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use crate::command_line::build_command_line;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

struct SuspendedChild {
    process: OwnedHandle,
    thread: OwnedHandle,
    armed: bool,
}

impl Drop for SuspendedChild {
    fn drop(&mut self) {
        if self.armed {
            unsafe {
                let _ = TerminateProcess(self.process.0, 1);
            }
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn run(owner_pid: u32, executable: &str, args: &[String]) -> Result<u32, ()> {
    let owner = OwnedHandle(unsafe {
        OpenProcess(PROCESS_SYNCHRONIZE_RIGHTS(SYNCHRONIZE.0), false, owner_pid).map_err(|_| ())?
    });
    let job = OwnedHandle(unsafe { CreateJobObjectW(None, None).map_err(|_| ())? });
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|_| ())?;
    }

    let executable_path = Path::new(executable);
    let mut command_line = wide(&build_command_line(executable_path, args));
    let executable_wide = wide(executable);
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE).map_err(|_| ())? };
    startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE).map_err(|_| ())? };
    startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE).map_err(|_| ())? };
    let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        CreateProcessW(
            PCWSTR(executable_wide.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED,
            None,
            PCWSTR::null(),
            &startup,
            &mut process_info,
        )
        .map_err(|_| ())?;
    }
    let mut child = SuspendedChild {
        process: OwnedHandle(process_info.hProcess),
        thread: OwnedHandle(process_info.hThread),
        armed: true,
    };
    unsafe {
        AssignProcessToJobObject(job.0, child.process.0).map_err(|_| ())?;
        if ResumeThread(child.thread.0) == u32::MAX {
            return Err(());
        }
    }
    child.armed = false;

    loop {
        let child_state = unsafe { WaitForSingleObject(child.process.0, 25) };
        if child_state == WAIT_OBJECT_0 {
            let mut exit_code = 0;
            unsafe {
                GetExitCodeProcess(child.process.0, &mut exit_code).map_err(|_| ())?;
            }
            return Ok(exit_code);
        }
        if child_state != WAIT_TIMEOUT {
            return Err(());
        }
        if unsafe { WaitForSingleObject(owner.0, 0) } == WAIT_OBJECT_0 {
            return Err(());
        }
    }
}
