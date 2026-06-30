# Supabase + Admin Kurulumu

Bu surumde oda olusturma yetkisi hesaba baglandi. Izleyiciler davet koduyla odaya katilabilir; oda olusturmak icin aktif egitmen veya admin hesabi gerekir.

## Supabase

1. Supabase'de yeni proje olustur.
2. Project Settings > Database bolumunden Postgres connection string al.
3. Render'da `DATABASE_URL` alanina bu connection string'i gir.

Uygulama ilk acilista gerekli tablolari otomatik olusturur:

- `users`
- `referral_codes`

## Render Environment Variables

Render servisinde su alanlari doldur:

- `DATABASE_URL`: Supabase Postgres connection string
- `SESSION_SECRET`: Render otomatik uretebilir
- `ADMIN_USERNAME`: admin panel giris kullanici adi, ornek `admin`
- `ADMIN_PASSWORD`: admin panel sifresi, en az 8 karakter
- `ADMIN_EMAIL`: istege bagli; bos kalirsa `ADMIN_USERNAME@dersflow.local` kullanilir
- `ADMIN_NAME`: panelde gorunen admin adi

## Admin Girisi

Sitedeki hesap alaninda:

- Kullanici adi/e-posta: `ADMIN_USERNAME`
- Sifre: `ADMIN_PASSWORD`

Bu bilgiler dogruysa oda olusturma karti gizlenir ve direkt admin panel acilir.

Admin panelden referans kodu olusturabilirsin. Egitmenler bu kodla kayit olunca oda acma yetkisi alir.
