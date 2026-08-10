# Müşteri D365 Ortamları — Güvenli Otomatik Bağlantı Kurulumu

Platform, müşteri **Business Central** ve **Finance & SCM** ortamlarına
salt-okunur, kimlik doğrulamalı otomatik bağlantı kurar; keşfedilen ortam
bilgisi (şirketler, URL'ler) doküman üretimi ve danışmanlık çıktılarında
kullanılır. UI: **Admin → Müşteri Ortamları** (`/settings/environments`).

## Güvenlik modeli

- Client secret'lar veritabanında **AES-256-GCM** ile şifrelenir
  (`CRED_MASTER_KEY` env — 32+ karakter rastgele değer; `.env`'de otomatik
  üretildi). Anahtar yoksa secret kaydı **reddedilir** (fail-closed).
- Secret'lar API'dan **asla geri dönmez** (yalnızca `has_secret` bayrağı);
  rotasyon write-only endpoint ile yapılır.
- Her secret çözme işlemi audit log'a yazılır.
- Kullanım salt-okunur keşifle sınırlıdır (companies / legal entities).
  Yazma operasyonları bilinçli olarak eklenmemiştir.

## Müşteri başına Entra app kaydı (her iki üründe ortak)

Müşterinin tenant'ında (veya delegasyonla sizin tenant'ta multi-tenant app):

1. Azure Portal → **App registrations → New registration** (örn. `DynOps-Reader`).
2. **Certificates & secrets** → yeni client secret oluştur (süreyi not al).
3. Tenant ID + Application (client) ID + secret'ı platforma girin.

### Business Central için ek adımlar

1. App registration → **API permissions → Dynamics 365 Business Central →
   Application permissions → `API.ReadWrite.All`** (+ isterseniz
   `Automation.ReadWrite.All`) → **Grant admin consent**.
2. BC ortamında: **Admin Center → Environments → (ortam) → Entra Apps** *veya*
   BC içinde **Microsoft Entra Applications** sayfası → app'i ekleyin ve
   **salt-okunur bir izin seti** verin (örn. `D365 READ` benzeri özel permission set).
3. Platformda `base_url` alanına **environment adını** yazın (örn. `Production`).

Probe çağrısı: `GET https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/v2.0/companies`

### Finance & SCM için ek adımlar

1. App registration'ı yapın (izin eklemek gerekmez; F&O kendi tarafında yetkilendirir).
2. F&O'da: **System administration → Setup → Microsoft Entra applications**
   → yeni satır: Client ID + kullanıcı eşlemesi (salt-okunur yetkili bir
   servis kullanıcısı önerilir, örn. sadece sorgu rolleri).
3. Platformda `base_url` = `https://<ortam>.operations.dynamics.com`
   (örn. `https://agaprod.operations.eu.dynamics.com`).

Probe çağrısı: `GET {base_url}/data/LegalEntities?cross-company=true`

## Akış

Ortam ekle → **Bağlantıyı test et** → durum `connected` + şirket listesi
karta düşer → o müşterinin story dokümanları ve rol brifleri artık
"=== MÜŞTERİ ORTAMLARI ===" bloğuyla gerçek ortam bilgisi içerir.

Sorun giderme: 401 → admin consent / BC-F&O tarafı app kaydı eksik;
403 (BC) → environment'ta Entra app izin seti yok; `AADSTS7000215` → secret
yanlış/expired → "Secret döndür" ile rotasyon yapın.

## Oturum Bağışlama — "Bir kez izin ver, platform kendi devam etsin"

MFA'lı gerçek kullanıcılarla (örn. deniz@dynamicsops.com) otomatik ekran
görüntüsü almanın onaylı yolu:

1. **İzin isteği:** Platform ekran görüntüsü almak istediğinde oturum yoksa /
   süresi dolmuşsa `env_session_expired` bildirimi düşer.
2. **Yetki verme (tek komut):** `node scripts/env-login.mjs <environmentId>`
   — makinenizde görünür bir tarayıcı açılır, girişi MFA dahil SİZ yaparsınız
   (şifreniz hiçbir yerde saklanmaz), giriş bitince tarayıcı oturumu
   (storageState çerezleri) AES-256-GCM şifreli olarak platforma kaydedilir.
3. **Otomatik devam:** Shotter her ekran görüntüsünde bu oturumu kullanır ve
   BAŞARILI HER KULLANIMDA oturumu yeniler (kayan pencere — KMSI ile ~90 güne
   kadar). Doküman üretimi tamamen otomatik akar.
4. **Süre dolunca:** Shotter kimlik denemez, `session_expired` döner; platform
   bildirim üretir; adım 2'yi tekrar çalıştırırsınız (≈30 sn + 1 MFA onayı).

Ortam listesi için argümansız çalıştırın: `node scripts/env-login.mjs`
