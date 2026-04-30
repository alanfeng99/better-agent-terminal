const ASCII_CONTROL_EXCEPT_CRLF_TAB = /[\x00-\x08\x0B-\x0C\x0E-\x1A\x1C-\x1F\x7F]/

// child_process fallback writes to a plain stdin pipe, not a real PTY.
// Only normalize line endings for plain text input so escape/control
// sequences such as arrow keys keep their original bytes.
export function normalizeInputForPipeShell(data: string): string {
  if (!data.includes('\r')) {
    return data
  }
  if (data.includes('\x1b')) {
    return data
  }
  if (ASCII_CONTROL_EXCEPT_CRLF_TAB.test(data)) {
    return data
  }
  return data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
