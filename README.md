# Messenger OpenClaw Bridge

Bridge nho de Facebook Messenger goi vao OpenClaw:

Facebook Page Messenger -> Meta Webhook -> bridge nay -> OpenClaw Gateway -> Meta Send API.

## Can chuan bi

- Node.js 20+.
- OpenClaw Gateway dang chay.
- Gateway bat endpoint `/v1/chat/completions`.
- Meta Developer App co Messenger Platform va mot Facebook Page.
- Page Access Token, Verify Token, va nen co App Secret.

## Cai dat

```bash
cd /opt/openclaw/.openclaw/workspace-main/messenger-openclaw-bridge
cp .env.example .env
```

Sua `.env`:

- `META_VERIFY_TOKEN`: chuoi bi mat tu dat, dung de verify webhook voi Meta.
- `META_PAGE_ACCESS_TOKEN`: Page Access Token cua Facebook Page.
- `META_PAGE_ACCESS_TOKENS`: danh sach Page Access Token khi bot tra loi nhieu Page, dang `PAGE_ID=TOKEN,PAGE_ID_2=TOKEN_2`.
- `META_PAGE_ACCESS_TOKENS_EXTRA`: danh sach bo sung cung dinh dang voi `META_PAGE_ACCESS_TOKENS`, dung khi dong token chinh qua dai.
- `META_APP_SECRET`: App Secret cua Meta App, khuyen nghi dien.
- `OPENCLAW_BASE_URL`: mac dinh `http://127.0.0.1:18789`.
- `OPENCLAW_AUTH_TOKEN`: Gateway token neu OpenClaw bat auth token/password.
- `OPENCLAW_MODEL`: mac dinh `openclaw/default`.
- `OPENCLAW_TRANSPORT`: `auto`, `http`, hoac `cli`. Nen de `auto`.
- `PUBLIC_BASE_URL`: domain public de Meta lay anh san pham, vi du `https://banmoc.tino.page`.
- `PUBLIC_ASSET_PATH`: public path cho anh san pham, mac dinh `/messenger-assets/`.

Chay:

```bash
npm start
```

Kiem tra:

```bash
curl http://127.0.0.1:3020/health
```

## Cau hinh OpenClaw

Bridge mac dinh dung `OPENCLAW_TRANSPORT=auto`:

- Thu HTTP `/v1/chat/completions` truoc.
- Neu Gateway chua bat endpoint nay, tu fallback sang CLI `openclaw agent --json`.

Neu muon dung HTTP thuan, endpoint `/v1/chat/completions` cua OpenClaw can duoc bat. Cau hinh Gateway can co:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

Neu Gateway dung token/password, dien cung gia tri vao `OPENCLAW_AUTH_TOKEN`.

## Cau hinh Meta Webhook

Trong Meta Developer:

1. Vao app -> Messenger Platform.
2. Them webhook URL:

   `https://your-domain.example.com/webhook`

3. Verify Token: dung dung gia tri `META_VERIFY_TOKEN`.
4. Subscribe event `messages` cho Page.

Khi deploy local, can dua port `3020` ra HTTPS public bang reverse proxy, Cloudflare Tunnel, ngrok, hoac Tailscale Funnel.

## Luu y an toan

- Khong expose OpenClaw Gateway token ra public.
- Public chi nen expose bridge `/webhook`, khong expose Gateway truc tiep.
- Nen dien `META_APP_SECRET` de bridge verify chu ky `X-Hub-Signature-256`.
- Bot hien xu ly text. Attachment se duoc tra loi bang thong bao ngan.
- Khi khach hoi ruou tam giac mach, bridge gui them anh trong `public/` qua `/messenger-assets/`.
