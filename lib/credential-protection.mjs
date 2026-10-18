// Windows CurrentUser DPAPI. Secrets travel through private child pipes, never
// command-line arguments, files, browser storage or environment variables.
import { spawnSync } from 'node:child_process';
export function windowsCredentialProtection({ platform = process.platform, exec = spawnSync } = {}) {
  function crypt(bytes, decrypt) {
    if (platform !== 'win32') throw Error('OS credential protection unavailable. No plaintext fallback is allowed.');
    const action = decrypt ? 'Unprotect' : 'Protect';
    const code = `Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $outputBytes=[Security.Cryptography.ProtectedData]::${action}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
    const r = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { input: Buffer.from(bytes).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout || !/^[A-Za-z0-9+/]+=*$/.test(r.stdout.trim())) throw Error('OS credential protection failed. No credentials were saved.');
    return Buffer.from(r.stdout.trim(), 'base64');
  }
  return {
    id: 'windows-current-user-dpapi-v1',
    isAvailable: () => platform === 'win32',
    encrypt: text => crypt(Buffer.from(text, 'utf8'), false),
    decrypt: bytes => crypt(bytes, true).toString('utf8'),
  };
}
