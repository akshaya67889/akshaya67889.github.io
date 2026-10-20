"""Run with the project served at http://127.0.0.1:8765. API fixtures are tests only."""
import json
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765'
API = 'https://ewdpamsogpqhuzreaayo.supabase.co'
results = []

def check(name, condition):
    assert condition, name
    results.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/inbox.html')
    page.wait_for_selector('#auth-view')
    check('private dashboard hidden before login', page.locator('#app-view').is_hidden())
    check('no private mailbox requests before login', page.locator('#auth-email').is_visible())
    check('mobile login has no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    page.goto(BASE + '/index.html#mail')
    page.wait_for_selector('#mail-form:visible')
    check('public mail form retained', page.locator('#mail-submit').inner_text() == 'Publish publicly')
    check('public warning retained', 'public and visible to anyone' in page.locator('.public-disclosure').first.inner_text())
    check('private inbox linked from mail tab', page.locator('#mail a[href="inbox.html"]').count() >= 1)
    check('existing four navigation tabs retained', page.locator('.page-tabs .tab-link').count() == 4)
    check('public mail mobile has no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

    fixture = {
        'id': 'test-message', 'gmail_message_id': 'gmail-test',
        'source_account_id': 'source-1', 'source_status': 'verified',
        'source_id': 'source-1', 'source_identity_status': 'verified',
        'original_sender': 'sender@example.net', 'original_from': 'sender@example.net',
        'subject': '<img src=x onerror=alert(1)> Test subject',
        'received_at': '2026-10-20T05:00:00Z', 'is_read': False,
        'snippet': 'Safe preview', 'text_body': '<script>window.attack=1</script> Test content',
        'html_body': '<img src="https://tracker.invalid/pixel"><script>window.attack=1</script><p>HTML content</p>',
        'attachments': [{'filename': 'invoice.pdf', 'mimeType': 'application/pdf', 'size': 42}]
    }
    actions = []
    def mock(route):
        body = route.request.post_data_json
        action = body.get('action')
        actions.append(body)
        data = {}
        if action == 'status':
            data = {'configured': True, 'connection': {'email': 'central@example.com', 'status': 'connected'}, 'sources': [{'id': 'source-1', 'email': 'forwarder@example.com', 'route_address': 'central+test@example.com', 'status': 'verified'}], 'errors': []}
        elif action == 'list': data = {'messages': [fixture], 'has_more': False}
        elif action == 'detail': data = {'message': fixture}
        elif action == 'read': data = {'message': {'id': 'test-message', 'is_read': True}}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(data), headers={'access-control-allow-origin': '*'})
    page.route(API + '/functions/v1/protected-inbox', mock)
    page.goto(BASE + '/inbox.html')
    page.evaluate("sessionStorage.setItem('pollpe_inbox_session',JSON.stringify({access_token:'test-token',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{email:'owner@example.com'}}))")
    page.reload()
    page.wait_for_selector('.message-card')
    check('forwarding account separate from original sender', 'forwarder@example.com' in page.locator('.message-card').inner_text() and 'sender@example.net' in page.locator('.message-card').inner_text())
    check('email subject cannot inject HTML', page.locator('.message-card img').count() == 0)
    page.locator('.message-card').click()
    page.wait_for_selector('#detail-dialog[open]')
    check('detail loads full body from server', any(x['action'] == 'detail' for x in actions))
    check('email scripts cannot execute', page.evaluate('window.attack === undefined'))
    check('attachment metadata shown', 'invoice.pdf' in page.locator('#detail-dialog').inner_text())
    page.locator('#close-detail').click()
    page.locator('#settings-button').click()
    check('owner settings available', page.locator('#settings-view').is_visible())
    check('signed-in mobile has no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    fixture['source_status'] = 'unknown'
    fixture['source_identity_status'] = 'unknown'
    page.reload()
    page.wait_for_selector('.message-card')
    check('unverified identity is never guessed from sender', 'Unknown forwarding account' in page.locator('.message-card').inner_text())
    fixture['source_status'] = 'manual'
    fixture['source_identity_status'] = 'manual_unverified'
    page.reload()
    page.wait_for_selector('.message-card')
    check('manual identity is clearly labeled unverified', page.locator('.message-card .badge').inner_text() == 'Manual label')
    check('manual identity never gets verified badge', page.locator('.message-card .badge-verified').count() == 0)
    page.locator('.message-card').click()
    page.wait_for_selector('#detail-dialog[open]')
    check('message ID visible for source verification', 'gmail-test' in page.locator('#detail-meta').inner_text())
    check('individual imported copy can be deleted', page.get_by_role('button', name='Delete imported copy').is_visible())
    page.locator('#close-detail').click()
    page.locator('#logout-button').click()
    check('logout restores private gate', page.locator('#app-view').is_hidden())
    check('logout clears private session', page.evaluate("sessionStorage.getItem('pollpe_inbox_session') === null"))
    check('logout removes message content from DOM', page.locator('.message-card').count() == 0 and page.locator('#detail-body').inner_text() == '')
    check('no browser runtime errors', not errors)
    browser.close()
print(json.dumps({'passed': len(results), 'checks': results}, indent=2))
