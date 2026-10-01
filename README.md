# Website Ujian Sekolah

Project pembelajaran website ujian sekolah lokal untuk siswa dan admin. Project ini sengaja tidak disiapkan untuk Vercel.

## Fitur utama

- Login siswa memakai **kode ujian + username ujian** yang unik per siswa.
- Setelah login, siswa melihat mata pelajaran yang ditugaskan.
- Halaman pemberitahuan menampilkan jadwal mulai yang dapat diatur admin.
- Tombol **Mulai Ujian** terkunci sebelum jam mulai.
- Soal pilihan ganda A-E yang dikelola admin.
- Jawaban tersimpan otomatis ke database JSON lokal.
- Panel nomor soal: **merah = belum dikerjakan**, **hijau = sudah dikerjakan**.
- Timer ujian dan submit otomatis saat waktu habis.
- Kelas: **10, 11, 12**.
- Jurusan: **AKUTANSI, TBSM, TKJ**.
- Admin dapat mengelola ujian, siswa, jadwal, identitas sekolah, dan bank soal.
- Rekap attempt/nilai siswa tampil di dashboard admin.

## Menjalankan di VS Code

1. Pastikan Node.js 20+ terpasang.
2. Buka folder project ini di VS Code.
3. Jalankan:

```bash
npm install
npm start
```

4. Buka `http://localhost:3000` untuk portal siswa.
5. Buka `http://localhost:3000/admin` untuk panel admin.

Akun admin demo pertama:

- Username: `admin`
- Password: `admin123`

Data demo siswa pertama:

- Username: `siswa01`
- Kode ujian: `BINDO-101`

Ubah data demo dari panel admin sebelum dipakai untuk simulasi lebih lanjut.

## Catatan

Database aktif disimpan di `data/db.json` dan otomatis dibuat dari `data/seed.json` saat pertama kali dijalankan. Karena file database di-gitignore, data lokal tidak ikut terdorong ke GitHub.

Project ini adalah pondasi pembelajaran. Untuk dipakai pada ujian sekolah sungguhan, autentikasi admin, penyimpanan terpusat, audit log, backup, pembatasan perangkat/browser, dan keamanan jaringan perlu ditingkatkan.
