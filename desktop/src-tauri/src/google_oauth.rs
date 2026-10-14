//! One pending Google return, bound before the system browser opens.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri_plugin_opener::OpenerExt;

const TIMEOUT: Duration = Duration::from_secs(300);
const READ_POLL: Duration = Duration::from_millis(50);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CONNECTIONS: usize = 16;
const PATH: &str = "/oauth/google";

#[derive(Default)]
pub struct GoogleOAuthListener(Mutex<Option<Attempt>>);

struct Attempt {
    state: String,
    cancel: Arc<AtomicBool>,
    receiver: Option<mpsc::Receiver<Result<String, String>>>,
}

#[tauri::command]
pub fn google_oauth_listen(
    state: String,
    listener: tauri::State<'_, GoogleOAuthListener>,
) -> Result<String, String> {
    if state.len() < 16
        || state.len() > 512
        || !state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid OAuth state".into());
    }
    let socket = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not start the local sign-in listener")?;
    let port = socket
        .local_addr()
        .map_err(|_| "Could not read the local sign-in port")?
        .port();
    socket
        .set_nonblocking(true)
        .map_err(|_| "Could not start the local sign-in listener")?;
    let cancel = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::channel();
    let old = listener
        .0
        .lock()
        .map_err(|_| "Sign-in listener unavailable")?
        .take();
    if let Some(old) = old {
        old.cancel.store(true, Ordering::SeqCst);
    }
    let worker_cancel = cancel.clone();
    let worker_state = state.clone();
    std::thread::spawn(move || {
        let _ = sender.send(run_listener(
            socket,
            port,
            &worker_state,
            &worker_cancel,
            TIMEOUT,
        ));
    });
    *listener
        .0
        .lock()
        .map_err(|_| "Sign-in listener unavailable")? = Some(Attempt {
        state,
        cancel,
        receiver: Some(receiver),
    });
    Ok(format!("http://127.0.0.1:{port}{PATH}"))
}

#[tauri::command]
pub async fn google_oauth_wait(
    state: String,
    listener: tauri::State<'_, GoogleOAuthListener>,
) -> Result<String, String> {
    let receiver = {
        let mut guard = listener
            .0
            .lock()
            .map_err(|_| "Sign-in listener unavailable")?;
        let attempt = guard.as_mut().ok_or("No sign-in in progress")?;
        if attempt.state != state {
            return Err("Sign-in state mismatch".into());
        }
        attempt.receiver.take().ok_or("Sign-in already waiting")?
    };
    let result = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|_| "Sign-in listener stopped")?
        .map_err(|_| "Sign-in listener stopped")?;
    let mut guard = listener
        .0
        .lock()
        .map_err(|_| "Sign-in listener unavailable")?;
    if guard.as_ref().is_some_and(|attempt| attempt.state == state) {
        guard.take();
    }
    result
}

#[tauri::command]
pub fn google_oauth_cancel(listener: tauri::State<'_, GoogleOAuthListener>) {
    if let Ok(mut guard) = listener.0.lock() {
        if let Some(attempt) = guard.take() {
            attempt.cancel.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub fn google_oauth_open_browser(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid Google sign-in URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("accounts.google.com")
        || parsed.path() != "/o/oauth2/v2/auth"
        || parsed.port().is_some()
        || parsed.username() != ""
        || parsed.password().is_some()
    {
        return Err("Invalid Google sign-in URL".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Could not open the system browser".into())
}

fn run_listener(
    socket: TcpListener,
    port: u16,
    state: &str,
    cancel: &Arc<AtomicBool>,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let (sender, receiver) = mpsc::channel();
    let active = Arc::new(AtomicUsize::new(0));
    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled".into());
        }
        if let Ok(result) = receiver.try_recv() {
            return result;
        }
        match socket.accept() {
            Ok((mut stream, peer)) if peer.ip().is_loopback() => {
                if active.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    respond(&mut stream, 503, "Sign-in listener busy");
                    continue;
                }
                active.fetch_add(1, Ordering::SeqCst);
                let sender = sender.clone();
                let active = active.clone();
                let state = state.to_owned();
                let cancel = cancel.clone();
                std::thread::spawn(move || {
                    if let Some(result) =
                        handle_request(&mut stream, port, &state, &cancel, deadline)
                    {
                        let _ = sender.send(result);
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(_) => return Err("Local sign-in listener failed".into()),
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("Sign-in cancelled".into());
    }
    Err("Google sign-in timed out. Try again.".into())
}

fn handle_request(
    stream: &mut TcpStream,
    port: u16,
    state: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Option<Result<String, String>> {
    let request_deadline = Instant::now() + REQUEST_TIMEOUT;
    let mut bytes = [0u8; 8192];
    let mut size = 0;
    while size < bytes.len() {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let remaining = deadline
            .min(request_deadline)
            .checked_duration_since(Instant::now())?;
        stream
            .set_read_timeout(Some(remaining.min(READ_POLL)))
            .ok()?;
        let read = match stream.read(&mut bytes[size..]) {
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return None,
        };
        if read == 0 {
            break;
        }
        size += read;
        if bytes[..size].windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    if !bytes[..size].windows(4).any(|part| part == b"\r\n\r\n") {
        respond(stream, 400, "Invalid sign-in return");
        return None;
    }
    let request = std::str::from_utf8(&bytes[..size]).ok()?;
    let mut lines = request.split("\r\n");
    let first = lines.next()?;
    let Some(target) = first
        .strip_prefix("GET ")
        .and_then(|line| line.strip_suffix(" HTTP/1.1"))
    else {
        respond(stream, 400, "Invalid sign-in return");
        return None;
    };
    if !lines.any(|line| line.eq_ignore_ascii_case(&format!("Host: 127.0.0.1:{port}"))) {
        respond(stream, 400, "Invalid sign-in return");
        return None;
    }
    let Some(query) = target.strip_prefix(&format!("{PATH}?")) else {
        respond(stream, 404, "Not found");
        return None;
    };
    let mut code = None;
    let mut returned_state = None;
    let mut error = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" if code.is_none() && !value.is_empty() && value.len() <= 2048 => {
                code = Some(value.into_owned())
            }
            "state" if returned_state.is_none() => returned_state = Some(value.into_owned()),
            "error" if error.is_none() && !value.is_empty() => error = Some(value.into_owned()),
            "code" | "state" | "error" => {
                respond(stream, 400, "Invalid sign-in return");
                return None;
            }
            _ => {}
        }
    }
    if returned_state.as_deref() != Some(state) {
        respond(stream, 400, "Sign-in state did not match");
        return None;
    }
    if code.is_some() && error.is_some() {
        respond(stream, 400, "Invalid sign-in return");
        return None;
    }
    if let Some(code) = code {
        respond(stream, 200, "Google sign-in received. Return to Exo.");
        return Some(Ok(code));
    }
    if error.is_some() {
        respond(stream, 200, "Google sign-in was cancelled. Return to Exo.");
        return Some(Err("Google sign-in was cancelled".into()));
    }
    respond(stream, 400, "Invalid sign-in return");
    None
}

fn respond(stream: &mut TcpStream, status: u16, message: &str) {
    let body = format!("<!doctype html><title>Exo</title><p>{message}</p>");
    let response = format!("HTTP/1.1 {status} OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(port: u16, query: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            stream,
            "GET {PATH}?{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }
    #[test]
    fn mismatch_is_rejected_then_matching_return_is_one_shot() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        socket.set_nonblocking(true).unwrap();
        let task = std::thread::spawn(move || {
            run_listener(
                socket,
                port,
                "expectedstate123456",
                &Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
        });
        assert!(request(port, "code=bad&state=wrongstate123456").starts_with("HTTP/1.1 400"));
        assert!(request(port, "code=good&state=expectedstate123456").starts_with("HTTP/1.1 200"));
        assert_eq!(task.join().unwrap().unwrap(), "good");
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }
    #[test]
    fn listener_times_out() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        socket.set_nonblocking(true).unwrap();
        assert!(run_listener(
            socket,
            0,
            "expectedstate123456",
            &Arc::new(AtomicBool::new(false)),
            Duration::from_millis(30)
        )
        .unwrap_err()
        .contains("timed out"));
    }

    #[test]
    fn google_metadata_is_accepted_but_duplicate_security_fields_are_rejected() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        socket.set_nonblocking(true).unwrap();
        let task = std::thread::spawn(move || {
            run_listener(
                socket,
                port,
                "expectedstate123456",
                &Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
        });
        for query in [
            "code=one&code=two&state=expectedstate123456",
            "code=one&state=expectedstate123456&state=expectedstate123456",
            "error=access_denied&error=other&state=expectedstate123456",
            "code=one&error=access_denied&state=expectedstate123456",
        ] {
            assert!(request(port, query).starts_with("HTTP/1.1 400"), "{query}");
        }
        assert!(request(port, "code=good&state=expectedstate123456&scope=openid+email+profile&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com&hd=example.com").starts_with("HTTP/1.1 200"));
        assert_eq!(task.join().unwrap().unwrap(), "good");
    }

    #[test]
    fn slow_connection_does_not_block_real_callback() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        socket.set_nonblocking(true).unwrap();
        let task = std::thread::spawn(move || {
            run_listener(
                socket,
                port,
                "expectedstate123456",
                &Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
        });
        let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
        slow.write_all(b"GET ").unwrap();
        let trickle = std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(25));
                if slow.write_all(b"a").is_err() {
                    break;
                }
            }
        });
        std::thread::sleep(Duration::from_millis(40));
        let start = Instant::now();
        assert!(request(port, "code=good&state=expectedstate123456").starts_with("HTTP/1.1 200"));
        assert_eq!(task.join().unwrap().unwrap(), "good");
        assert!(start.elapsed() < Duration::from_secs(1));
        trickle.join().unwrap();
    }

    #[test]
    fn partial_connection_cannot_extend_absolute_deadline() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        socket.set_nonblocking(true).unwrap();
        let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
        slow.write_all(b"GET ").unwrap();
        let trickle = std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(25));
                if slow.write_all(b"a").is_err() {
                    break;
                }
            }
        });
        let start = Instant::now();
        let result = run_listener(
            socket,
            port,
            "expectedstate123456",
            &Arc::new(AtomicBool::new(false)),
            Duration::from_millis(150),
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_millis(500));
        trickle.join().unwrap();
    }

    #[test]
    fn cancellation_interrupts_partial_request() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        socket.set_nonblocking(true).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let task = std::thread::spawn(move || {
            run_listener(
                socket,
                port,
                "expectedstate123456",
                &worker_cancel,
                Duration::from_secs(2),
            )
        });
        let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
        slow.write_all(b"GET ").unwrap();
        std::thread::sleep(Duration::from_millis(40));
        let start = Instant::now();
        cancel.store(true, Ordering::SeqCst);
        assert!(task.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(start.elapsed() < Duration::from_millis(300));
    }
}
