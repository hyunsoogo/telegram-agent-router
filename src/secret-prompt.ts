export async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('secure token prompt requires a terminal; use a profile-specific TELEGRAM_BOT_TOKEN_* environment variable')
  }
  process.stdout.write(prompt)
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')

  return await new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else if (!value.trim()) reject(new Error('token cannot be empty'))
      else resolve(value.trim())
    }
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          finish(new Error('token input cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (character < ' ') continue
        value += character
        process.stdout.write('*')
      }
    }
    input.on('data', onData)
  })
}
