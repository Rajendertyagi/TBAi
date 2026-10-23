//! Named kill-on-close job that binds the sidecar to the desktop shell.
//!
//! The shell creates the job **before** spawning the sidecar and keeps the only
//! handle. The sidecar opens the job by name, assigns itself, and immediately
//! closes its own handle. If the shell dies first the job is gone and the
//! sidecar refuses to boot; if the shell dies later the last handle closes, the
//! job is destroyed, and Windows terminates the sidecar.
//!
//! Why this exists: `tauri-plugin-shell`'s `set_process_group(true)` also puts
//! the sidecar in a job, but that job has no `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
//! A hard shell kill therefore leaves the sidecar running. This module adds the
//! missing limit. The sidecar's own job (created in Bun) covers its children.
//!
//! `ShellJob` stores the handle as `isize` rather than `HANDLE` so the value is
//! `Send`/`Sync` and can live in Tauri's managed state without an unsafe impl.
//! The handle is only closed by `close`/`Drop`, serialized by the state mutex.

use std::io;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The shell's only handle to the named job.
    pub struct ShellJob {
        name: String,
        handle: isize,
    }

    impl ShellJob {
        /// Creates `name` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
        ///
        /// The name must be a valid Win32 object name (`Local\...` for the
        /// per-session namespace). Fails rather than returning an unprotected
        /// job: the caller must abort the sidecar start on error.
        pub fn create(name: String) -> io::Result<Self> {
            let wide: Vec<u16> = std::ffi::OsStr::new(&name)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let handle = unsafe { CreateJobObjectW(ptr::null(), wide.as_ptr()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                unsafe { std::mem::zeroed() };
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &information as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(handle);
                }
                return Err(error);
            }
            Ok(Self {
                name,
                handle: handle as isize,
            })
        }

        /// Win32 object name passed to the sidecar as `TBAI_SHELL_JOB_NAME`.
        pub fn name(&self) -> &str {
            &self.name
        }

        /// Closes the only handle. Idempotent; also called by `Drop`.
        pub fn close(&mut self) {
            if self.handle != 0 {
                unsafe {
                    CloseHandle(self.handle as HANDLE);
                }
                self.handle = 0;
            }
        }

        #[cfg(test)]
        fn has_kill_on_close(&self) -> bool {
            use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;

            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                unsafe { std::mem::zeroed() };
            let mut returned = 0u32;
            let ok = unsafe {
                QueryInformationJobObject(
                    self.handle as HANDLE,
                    JobObjectExtendedLimitInformation,
                    &mut information as *mut _ as *mut c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    &mut returned,
                )
            };
            ok != 0
                && information.BasicLimitInformation.LimitFlags
                    & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    != 0
        }
    }

    impl Drop for ShellJob {
        fn drop(&mut self) {
            self.close();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn creates_a_named_job_with_kill_on_close() {
            let name = format!(
                "Local\\TBAiShellJobTest-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            );
            let mut job = ShellJob::create(name.clone()).expect("create job");
            assert_eq!(job.name(), name);
            assert!(job.has_kill_on_close(), "kill-on-close flag is missing");
            job.close();
            assert_eq!(job.handle, 0);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;

    /// Unused on non-Windows: `main.rs` only creates the named job on Windows.
    pub struct ShellJob {
        name: String,
    }

    impl ShellJob {
        pub fn create(name: String) -> io::Result<Self> {
            Ok(Self { name })
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        pub fn close(&mut self) {}
    }
}

pub use imp::ShellJob;
