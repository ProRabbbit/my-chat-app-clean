import { Hono } from 'hono';
import webpush from 'web-push';

const app = new Hono();

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.get("dummy");
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 履歴取得
    if (path.includes("/api/history")) {
      const { results } = await this.env.DB.prepare(
        "SELECT * FROM messages ORDER BY id DESC LIMIT 50"
      ).all();
      return Response.json(results.reverse());
    }

    // プッシュ通知の購読登録エンドポイント
    if (path.includes("/api/subscribe") && request.method === "POST") {
      const sub = await request.json();
      await this.env.DB.prepare(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?) " +
        "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth"
      ).bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth).run();
      return Response.json({ success: true });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(websocket) {
    websocket.accept();
    this.sessions.add(websocket);

    websocket.addEventListener("message", async (event) => {
      const data = JSON.parse(event.data);
      const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      const messageData = { name: data.name, text: data.text, time: time };

      // DBにメッセージ保存
      await this.env.DB.prepare(
        "INSERT INTO messages (name, text, time) VALUES (?, ?, ?)"
      ).bind(messageData.name, messageData.text, messageData.time).run();

      // 1. 開いているセッション（タブ）へリアルタイム送信
      for (const socket of this.sessions) {
        socket.send(JSON.stringify(messageData));
      }

      // 2. 登録されている全端末へWeb Push通知を送信
      if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) {
        console.error("VAPID keys are missing!");
        return;
      }

      webpush.setVapidDetails(
        'mailto:example@yourdomain.com',
        this.env.VAPID_PUBLIC_KEY,
        this.env.VAPID_PRIVATE_KEY
      );

      const { results: subs } = await this.env.DB.prepare("SELECT * FROM push_subscriptions").all();
      const payload = JSON.stringify({
        title: `${messageData.name} さんからのメッセージ`,
        body: messageData.text
      });

      for (const sub of subs) {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };

        try {
          await webpush.sendNotification(pushSubscription, payload);
        } catch (err) {
          console.error("Push notification error:", err.statusCode, err.body || err.message);

          if (err.statusCode === 404 || err.statusCode === 410) {
            await this.env.DB.prepare(
              "DELETE FROM push_subscriptions WHERE endpoint = ?"
            ).bind(sub.endpoint).run();
          }
        }
      }
    });

    websocket.addEventListener("close", () => {
      this.sessions.delete(websocket);
    });
  }
}

// APIルーティング
app.get("/api/history", async (c) => {
  const id = c.env.CHAT_ROOM.idFromName("default-room");
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

app.post("/api/subscribe", async (c) => {
  const id = c.env.CHAT_ROOM.idFromName("default-room");
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

app.get("/api/room/:id", async (c) => {
  const idParam = c.req.param("id");
  const id = c.env.CHAT_ROOM.idFromName(idParam);
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;