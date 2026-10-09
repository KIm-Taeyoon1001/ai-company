// Gmail SMTP 발송. 의존성 0개 원칙이라 node:tls 로 SMTP 를 직접 말한다.
// 보내는 계정(GMAIL_USER)은 2단계 인증 + 앱 비밀번호(GMAIL_APP_PASSWORD)가 있어야 한다.
// 받는 쪽(MAIL_TO)은 Claude 커넥터에 연결된 확인용 계정이다.
import tls from 'node:tls';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

export function mailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.MAIL_TO);
}

export async function sendMail({ subject, text, to = process.env.MAIL_TO }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD.replace(/\s/g, ''); // 구글이 4자리씩 띄워서 보여준다
  const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
  sock.setEncoding('utf8');
  sock.setTimeout(20_000, () => sock.destroy(new Error('SMTP 응답 없음')));

  let buf = '';
  const waiters = [];
  sock.on('data', (chunk) => {
    buf += chunk;
    // 여러 줄 응답은 "250-..." 로 이어지다 "250 ..." 에서 끝난다
    const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buf);
    if (m && waiters.length) {
      const reply = buf;
      buf = '';
      waiters.shift()({ code: Number(m[1]), reply });
    }
  });
  const failed = new Promise((_, reject) => sock.on('error', reject));
  const expect = async (code, line) => {
    const next = new Promise((r) => waiters.push(r));
    if (line !== undefined) sock.write(`${line}\r\n`);
    const res = await Promise.race([next, failed]);
    if (res.code !== code) throw new Error(`SMTP ${res.code}: ${res.reply.trim().slice(0, 200)}`);
    return res;
  };

  try {
    await expect(220);
    await expect(250, 'EHLO blackout');
    await expect(334, 'AUTH LOGIN');
    await expect(334, b64(user));
    await expect(235, b64(pass));
    await expect(250, `MAIL FROM:<${user}>`);
    await expect(250, `RCPT TO:<${to}>`);
    await expect(354, 'DATA');
    const body = b64(String(text)).replace(/.{76}/g, '$&\r\n');
    const msg = [
      `From: BLACK OUT <${user}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
      '.',
    ].join('\r\n');
    await expect(250, msg);
    sock.write('QUIT\r\n');
    return { ok: true };
  } finally {
    sock.end();
  }
}
