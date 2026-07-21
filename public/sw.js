// プッシュ通知を受信したときの処理
self.addEventListener('push', function (event) {
    const data = event.data ? event.data.json() : { title: 'チャット', body: '新着メッセージがあります' };
    
    const options = {
        body: data.body,
        icon: 'https://cloudflare.com/favicon.ico',
        badge: 'https://cloudflare.com/favicon.ico'
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// 通知をクリックしたときの処理（開いているタブがあればそこにフォーカスする）
self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});