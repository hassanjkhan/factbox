# Support email — what it is, and how to switch it on

`/support` has two boxes. Both post to `functions/support.js`, which writes the
message into Firestore and then, if it can, emails it to **hello@factbox.app**.

**The email is switched off right now**, deliberately, and the form works
anyway. Everything below is the four things the owner has to do to switch it
on. Until then every message still lands in `support/` in the Firebase console
and every reader still sees "Sent", because it was.

---

## 1. Why it is built this way round

**Store first, mail second, and never let the mail decide the answer.**

A support form that returns an error because a mail provider is having an
afternoon is worse than one that only archives. So the response to the reader
is settled entirely by whether the Firestore document was written. If the key
is absent, wrong, expired, rate-limited by the provider, or the provider is
down, the reader is told "Sent" — and they are being told the truth, because
the message is in the archive the founders read.

The consequence worth knowing: **a mail failure is silent to the reader and
loud in the logs.** `support mail failed` at ERROR level, with the document id
and the reason. If that line starts appearing, the founders are reading the
console without knowing it. Nothing is lost either way.

---

## 2. Why Resend, and not the other three options

| | Verdict |
|---|---|
| **`firestore-send-email` extension** | **No.** `functions/index.js` already carries this project's position, in writing: Firebase Extensions shut down on **31 March 2027**, and the Stripe extension was declined for exactly that reason. Installing one now means migrating it in eighteen months. It also still needs an SMTP credential or an API key — the same secret, plus a `mail/` collection to add to `firestore.rules`, plus documents to expire, plus a delivery path nobody can see from the function that produced it. More moving parts for less. |
| **Nodemailer over SMTP** | **No.** A new npm dependency, and a multi-round-trip TLS handshake inside a function with a 30-second budget. Worse, SMTP is the one option where **header injection is your problem**: you assemble headers, so a CRLF in the reader's address is a live escape and the only thing stopping it is your own parser being right. |
| **A transactional API — Resend, Postmark, SendGrid** | **Yes.** One HTTPS POST with `fetch`, which Node 20 has built in, so **no new dependency at all**. `to`, `subject` and `reply_to` are JSON fields rather than header lines, so there is no place a newline can split a header even if one got past the parser. Structurally safer, not just conventionally safer. |
| **Which one** | **Resend.** Any of the three would do and the code is about fifteen lines either way. Resend has the simplest domain verification, a free tier of 3,000 emails a month and 100 a day that this volume will never approach, and a plain JSON API with no SDK. Swapping to Postmark later is `MAIL_ENDPOINT`, the auth header, and `reply_to` → `ReplyTo`. |

---

## 3. What the owner must create, in order

**Do these in order. Step 4 is the one that turns it on, and nothing happens
until it runs.**

### 1 · A Resend account

<https://resend.com> → sign up. The free tier (3,000/month, 100/day) is more
than this form will ever use; the function caps itself at 80/day, below that
ceiling, on purpose.

### 2 · A sending domain — `send.factbox.app`, **not** `factbox.app`

In Resend: **Domains → Add Domain → `send.factbox.app`**, region `us-east-1`.

**Use the subdomain. This is not a style preference, and here is the specific
reason for this domain.** `factbox.app` today has:

```
MX   factbox.app   route1/2/3.mx.cloudflare.net        (Cloudflare Email Routing)
TXT  factbox.app   "v=spf1 include:_spf.mx.cloudflare.net ~all"
```

That is what makes **hello@factbox.app receive mail at all** — it is a
Cloudflare Email Routing forwarder, and Email Routing is inbound only, which is
why this feature needs an outside sender in the first place. Two things go
wrong if you verify the root domain instead:

- **A domain may have exactly one SPF record.** Adding Resend's `v=spf1
  include:amazonses.com` alongside the existing one does not merge them, it
  breaks both, and mail to hello@ starts failing SPF.
- Resend's MX record for feedback would sit beside Cloudflare's inbound MX at
  the same name.

A sending setup must not be able to break the mailbox it sends to. On
`send.factbox.app` all of Resend's records live at a name nothing else uses,
and the root is never touched.

### 3 · The DNS records, at Cloudflare

`factbox.app` is on Cloudflare nameservers (`pranab`/`faye.ns.cloudflare.com`),
so this is Cloudflare dashboard → the `factbox.app` zone → **DNS → Records**.

Resend shows you the exact values — **copy them from the dashboard, do not
type them from here.** They will be three records, all on the subdomain:

| Type | Name | Value | Proxy |
|---|---|---|---|
| `MX` | `send` | `feedback-smtp.us-east-1.amazonses.com`, priority `10` | n/a |
| `TXT` | `send` | `v=spf1 include:amazonses.com ~all` | n/a |
| `TXT` | `resend._domainkey.send` | the long DKIM public key Resend gives you | **DNS only** |

Cloudflare shortens names to the zone, so entering `send` produces
`send.factbox.app`. **Do not add, edit or delete anything at the bare
`factbox.app` name.** If Cloudflare offers to proxy a TXT record, it cannot —
but if it offers on anything here, the answer is DNS only.

Then in Resend press **Verify**. It takes a few minutes.

**While you are there, consider adding DMARC.** `_dmarc.factbox.app` does not
exist today, which means nobody is claiming the domain's mail policy. A
starting record, on the root, that changes nothing and only asks for reports:
`TXT  _dmarc  "v=DMARC1; p=none; rua=mailto:hello@factbox.app"`. This is
optional and unrelated to the form working.

### 4 · An API key, and the secret

In Resend: **API Keys → Create API Key**. Name it `factbox-support`,
permission **Sending access**, and scope it to `send.factbox.app`. Copy the key
— it begins `re_` and Resend shows it once.

Then, from the repo:

```
firebase functions:secrets:set RESEND_API_KEY      # paste the key at the prompt
firebase deploy --only functions:support           # required: picks up the new version
```

The secret already exists, holding the placeholder `disabled-see-SUPPORT-EMAIL.md`.
The above adds a new version and the redeploy is what makes the function read
it. **The key never touches the repo.** This repository is public; it lives in
Secret Manager and nowhere else.

### 5 · Check it

Send yourself a message from <https://factbox.app/support> and confirm three
things:

- the email arrives at hello@factbox.app;
- `support_meta/quota` in the Firestore console now has `mailCount: 1`;
- the log line for it says `"mail":"sent"` —
  `firebase functions:log --only support -n 5`.

If the email does not arrive, the log says why: `http_401` is a bad key,
`http_403` is usually an unverified domain, `timeout` is the provider being
slow. The message is in `support/` regardless.

---

## 4. What the email looks like, and why

Plain text. **No `html` field is sent at all**, so a message full of markup
arrives as the characters it is, in a client with nothing to execute.

```
A message from the Factbox support page.

Box      : Story idea
Page     : /read/07
Account  : abc123
Reply to : reader@example.com
Archived : support/2026-09-04T19-00-00Z-efgh

THAT REPLY ADDRESS IS UNVERIFIED. It is whatever was typed into the box and
nobody proved they own it. Replying tells that address a human read this.

----- message begins [2026-09-04T19-00-00Z-efgh] -----
Do one on the Antikythera mechanism.
----- message ends [2026-09-04T19-00-00Z-efgh] -----

Read it, and delete it, in the Firebase console:
https://console.firebase.google.com/project/factbox-7cb97/firestore/data/~2Fsupport~2F2026-09-04T19-00-00Z-efgh
```

Five decisions in there, all of them because **the body is written by anonymous
strangers**:

1. **`To:` is a constant.** `MAIL_TO` in the source, never a value from the
   request, not once and not conditionally. A `To:` a stranger can set is an
   open relay sending spam from our own domain and our own reputation, and it
   is the single most expensive mistake available on this page.
2. **Nothing the reader typed reaches a header.** The subject is built from the
   box name and the document id, both of which this server produced. There is
   no message snippet in the subject, tempting as that is.
3. **`Reply-To` is the one exception, and it is parsed strictly.** What gets
   *stored* uses a deliberately loose pattern, because the point there is to
   catch a typo. What may become a *header* goes through `replyTo()`, which
   permits one bare ASCII address and rejects display names, angle brackets,
   commas, semicolons, comments, quoting, tabs, non-ASCII and every form of
   CR/LF. An address that fails is still shown in the body, where it is text
   and can do nothing. 25 hostile inputs are asserted against it.
4. **The fence carries the document id.** With a fixed fence, a reader can type
   `----- message ends -----` and everything after it reads as ours — which is
   how a plausible instruction ends up in an email that appears to come from
   the site. The id is minted on the server after the message was typed, so it
   cannot be guessed and cannot be forged.
5. **The unverified banner is in every email.** Nobody proved they own that
   address. Read that line before hitting reply.

---

## 5. What this changed that lives outside these files

**`privacy.html` §08 is now wrong and needs one sentence changed.** It says:

> **Your IP address is not stored, and neither is a hash of it.**

That was true of the in-memory throttle and is not true of the Firestore one —
see BACKEND.md §4c for what is stored and why it had to be. The file belongs to
another hand, so this is flagged, not edited. Two other places in the same file
will want a look at the same time: the processor list in §09, which does not
name a mail provider, and §08's description of where a support message goes,
which says Firestore and stops there.

None of it is urgent while the mail is switched off and the counters carry no
address. All of it is due before the key goes in.
