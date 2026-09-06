// ============================================================
// PASTE YOUR APPS SCRIPT WEB APP URL HERE (ends in /exec)
// ============================================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzK270BdnoSfFyp2GJBm4qKyz7hZXXM7H28Xopctor7dTYEJSDw1GtxbyrnA9OMRwUXCw/exec';

const FACE_MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';

let mode = 'login';             // 'register' | 'login'
let pendingUser = null;         // { email, name } once registered
let faceCaptureAction = null;   // 'enroll' | 'login'
let stream = null;
let modelsLoaded = false;

const $ = id => document.getElementById(id);

function log(msg, cls) {
  const line = document.createElement('div');
  line.className = 'line';
  const t = new Date().toLocaleTimeString();
  line.innerHTML = '<span class="t">' + t + '</span><span class="' + (cls || '') + '">' + msg + '</span>';
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
}

function setStatus(msg, isError) {
  const el = $('statusMsg');
  el.textContent = msg || '';
  el.className = 'status ' + (isError ? 'err' : (msg ? 'ok' : ''));
}

// Calls the Apps Script web app. Body is sent as plain text (not
// application/json) on purpose — this avoids a CORS preflight request,
// which Apps Script's endpoint does not handle.
async function callApi(action, payload) {
  const res = await fetch(SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action, payload })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function setMode(next) {
  mode = next;
  pendingUser = null;
  $('tabLogin').classList.toggle('active', mode === 'login');
  $('tabRegister').classList.toggle('active', mode === 'register');
  $('nameField').style.display = mode === 'register' ? 'block' : 'none';
  $('primaryAction').style.display = mode === 'register' ? 'block' : 'none';
  $('primaryAction').textContent = 'Create account';
  $('primaryAction').disabled = false;
  $('scanDivider').style.display = mode === 'login' ? 'block' : 'none';
  $('scanArea').style.display = mode === 'login' ? 'block' : 'none';
  $('fingerprintLabel').textContent = mode === 'login' ? 'Fingerprint' : 'Enroll fingerprint';
  $('faceLabel').textContent = mode === 'login' ? 'Face scan' : 'Enroll face';
  stopCamera();
  setStatus('');
}

async function onPrimaryAction() {
  const name = $('nameInput').value.trim();
  const email = $('emailInput').value.trim();
  if (!name || !email) { setStatus('Enter your name and email first.', true); return; }

  $('primaryAction').disabled = true;
  setStatus('Creating account…');
  try {
    await callApi('registerUser', { name, email });
    pendingUser = { name, email };
    log('Account created for ' + email, 'ok');
    $('primaryAction').style.display = 'none';
    $('scanDivider').style.display = 'block';
    $('scanArea').style.display = 'block';
    setStatus('Account created. Now enroll a fingerprint and/or face.');
  } catch (err) {
    log('Register failed: ' + err.message, 'err');
    setStatus(err.message, true);
    $('primaryAction').disabled = false;
  }
}

function currentEmail() {
  return pendingUser ? pendingUser.email : $('emailInput').value.trim();
}

// ---------- Fingerprint (WebAuthn) ----------

function b64FromBuffer(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function bufferFromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function onFingerprint() {
  const email = currentEmail();
  if (!email) { setStatus('Enter your email first.', true); return; }
  if (!window.PublicKeyCredential) {
    setStatus('This browser does not support device biometrics (WebAuthn).', true);
    return;
  }

  const btn = $('fingerprintBtn');
  btn.disabled = true; btn.classList.add('busy');
  try {
    if (mode === 'register') {
      log('Requesting device biometric enrollment…', 'info');
      const challenge = await callApi('getChallenge', null);
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: new TextEncoder().encode(challenge),
          rp: { name: 'Biometric Attendance', id: location.hostname },
          user: {
            id: new TextEncoder().encode(email),
            name: email,
            displayName: pendingUser.name
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          timeout: 60000
        }
      });
      const credentialId = b64FromBuffer(cred.rawId);
      await callApi('saveCredential', { email, credentialId });
      log('Fingerprint/device credential enrolled.', 'ok');
      setStatus('Fingerprint enrolled successfully.');
    } else {
      log('Looking up enrolled credential…', 'info');
      const { credentialId } = await callApi('getCredentialForLogin', { email });
      const challenge = await callApi('getChallenge', null);
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: new TextEncoder().encode(challenge),
          allowCredentials: [{ id: bufferFromB64(credentialId), type: 'public-key' }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      const usedId = b64FromBuffer(assertion.rawId);
      const result = await callApi('verifyCredentialLogin', { email, credentialId: usedId });
      log('Fingerprint verified for ' + email, 'ok');
      showSuccess(result.name, 'via fingerprint', result.attendance);
    }
  } catch (err) {
    log('Fingerprint step failed: ' + err.message, 'err');
    setStatus(err.message, true);
  } finally {
    btn.disabled = false; btn.classList.remove('busy');
  }
}

// ---------- Face scan ----------

async function loadFaceModels() {
  if (modelsLoaded) return;
  log('Loading face-recognition models…', 'info');
  await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL);
  modelsLoaded = true;
  log('Face models ready.', 'ok');
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 } });
  $('video').srcObject = stream;
  $('cameraWrap').style.display = 'block';
}

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('cameraWrap').style.display = 'none';
  $('captureBtn').style.display = 'none';
  $('faceHint').style.display = 'none';
}

async function onFaceButton() {
  const email = currentEmail();
  if (!email) { setStatus('Enter your email first.', true); return; }

  faceCaptureAction = mode === 'register' ? 'enroll' : 'login';
  const btn = $('faceBtn');
  btn.disabled = true; btn.classList.add('busy');
  setStatus('Starting camera…');
  try {
    await loadFaceModels();
    await startCamera();
    $('faceHint').style.display = 'block';
    $('captureBtn').style.display = 'block';
    setStatus('Position your face in frame, then click Capture.');
  } catch (err) {
    log('Camera/model error: ' + err.message, 'err');
    setStatus('Could not start camera: ' + err.message, true);
  } finally {
    btn.disabled = false; btn.classList.remove('busy');
  }
}

async function onCapture() {
  const email = currentEmail();
  $('captureBtn').disabled = true;
  setStatus('Reading face…');
  try {
    const detection = await faceapi
      .detectSingleFace($('video'), new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) throw new Error('No face detected. Try better lighting and center your face.');

    const descriptor = Array.from(detection.descriptor);

    if (faceCaptureAction === 'enroll') {
      await callApi('saveFaceDescriptor', { email, descriptor });
      log('Face enrolled for ' + email, 'ok');
      setStatus('Face enrolled successfully.');
    } else {
      const result = await callApi('verifyFaceLogin', { email, descriptor });
      log('Face verified for ' + email, 'ok');
      showSuccess(result.name, 'via face scan', result.attendance);
    }
    stopCamera();
  } catch (err) {
    log('Face step failed: ' + err.message, 'err');
    setStatus(err.message, true);
  } finally {
    $('captureBtn').disabled = false;
  }
}

function showSuccess(name, via, attendance) {
  $('authView').style.display = 'none';
  $('successView').style.display = 'block';
  $('successName').textContent = name;
  let line = 'Authenticated ' + via;
  if (attendance) {
    line = attendance.type === 'checkin'
      ? 'Checked in at ' + attendance.time + ' (' + via + ')'
      : 'Checked out at ' + attendance.time + ' (' + via + ')';
  }
  $('successMeta').textContent = line + ' · ' + new Date().toLocaleDateString();
  log((attendance && attendance.type === 'checkin' ? 'Checked in: ' : 'Checked out: ') + name, 'ok');
}

setMode('login');
log('Console ready.', 'info');
if (SCRIPT_URL.indexOf('PASTE_YOUR') === 0) {
  log('SCRIPT_URL is not set yet — edit app.js.', 'err');
}
