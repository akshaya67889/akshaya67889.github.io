#!/usr/bin/env python3
"""Trusted route-to-source SMTP bridge.

The operator maps this process/route to SOURCE_EMAIL; From is never inferred.
The wrapper deliberately carries the original RFC Message-ID as its own
Message-ID so Gmail preserves the identifier bound by the gateway signature.
"""
import argparse
import hashlib
import hmac
import os
import re
import smtplib
import sys
import time
from email import policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, parseaddr


def text(value):
    return str(make_header(decode_header(value or "")))


def norm(value):
    return re.sub(r'\n{3,}', '\n\n', re.sub(r'[ \t]+\n', '\n', str(value).replace('\r\n', '\n').replace('\r', '\n'))).strip()


def readable_body(message):
    plain, html = [], []
    for part in message.walk() if message.is_multipart() else [message]:
        if part.get_content_disposition() == 'attachment':
            continue
        try:
            value = part.get_content()
        except Exception:
            continue
        if part.get_content_type() == 'text/plain':
            plain.append(value)
        elif part.get_content_type() == 'text/html':
            html.append(value)
    if plain:
        return norm('\n\n'.join(plain))
    if html:
        from html.parser import HTMLParser
        class PlainText(HTMLParser):
            def __init__(self):
                super().__init__()
                self.out = []
            def handle_data(self, data):
                self.out.append(data)
        parser = PlainText()
        parser.feed('\n'.join(html))
        return norm(''.join(parser.out))
    return ''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stdout', action='store_true')
    args = parser.parse_args()
    key = os.environ.get('INBOX_GATEWAY_HMAC_SECRET', '').encode()
    source = os.environ.get('INBOX_GATEWAY_SOURCE_EMAIL', '').strip().lower()
    gateway = os.environ.get('INBOX_GATEWAY_FROM', '').strip()
    destination = os.environ.get('CENTRAL_GMAIL_ADDRESS', '').strip()
    if len(key) < 32 or not source or not gateway or not destination:
        raise SystemExit('INBOX_GATEWAY_HMAC_SECRET (>=32), INBOX_GATEWAY_SOURCE_EMAIL, INBOX_GATEWAY_FROM, CENTRAL_GMAIL_ADDRESS required')

    raw = sys.stdin.buffer.read()
    message = BytesParser(policy=policy.default).parsebytes(raw)
    sender = parseaddr(text(message.get('From', '')))[1].lower()
    subject = norm(text(message.get('Subject', '')))
    message_id = text(message.get('Message-ID', '')).strip()
    if not message_id:
        raise SystemExit('original RFC Message-ID required')
    payload = readable_body(message)
    emitted_body = payload or '(Original message contained no readable text.)'
    stamp = str(int(time.time()))
    body_hash = hashlib.sha256(emitted_body.encode()).hexdigest()
    subject_hash = hashlib.sha256(subject.encode()).hexdigest()
    canonical = '\n'.join(['v1', stamp, message_id, source, sender, subject, body_hash])
    signature = hmac.new(key, canonical.encode(), hashlib.sha256).hexdigest()

    wrapper = EmailMessage(policy=policy.SMTP.clone(max_line_length=998))
    wrapper['From'] = gateway
    wrapper['To'] = destination
    wrapper['Date'] = formatdate(localtime=False)
    wrapper['Message-ID'] = message_id
    wrapper['Subject'] = subject
    wrapper['X-Inbox-Gateway'] = (
        f'v1;ts={stamp};source={source};sender={sender};msgid={message_id};'
        f'subject-sha256={subject_hash};body-sha256={body_hash};sig={signature}'
    )
    wrapper.set_content(emitted_body)
    # Preserve the original MIME message for audit/attachment metadata without
    # making the protected reader render it as active HTML.
    wrapper.add_attachment(raw, maintype='message', subtype='rfc822', filename='original-message.eml')

    if args.stdout:
        sys.stdout.buffer.write(wrapper.as_bytes())
        return
    host = os.environ['SMTP_HOST']
    port = int(os.environ.get('SMTP_PORT', '587'))
    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.starttls()
        smtp.login(os.environ['SMTP_USER'], os.environ['SMTP_PASSWORD'])
        smtp.send_message(wrapper)


if __name__ == '__main__':
    main()
