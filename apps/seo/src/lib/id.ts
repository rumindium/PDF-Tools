/**
 * Indonesian copy for the `/id/` snapshot pages (`docs/18-SEO-GROWTH-AND-BACKLOG.md` S3).
 *
 * Only home, the tools index, and the six highest-traffic tools are translated — the pages that can win
 * `gabung pdf` / `kompres pdf` queries. Everything else stays English-only, and `hreflang` lists exactly the
 * languages that exist (an alternate pointing at a page that was never built is worse than no alternate).
 *
 * Tool titles are translated, not transliterated: the query is `gabung pdf`, never `merge pdf`.
 */

export const ID_TOOL_IDS = ['merge', 'split', 'compress', 'pdf-to-office', 'pdf-to-images', 'ocr'] as const;

export type IdToolId = (typeof ID_TOOL_IDS)[number];

export interface IdToolCopy {
  title: string;
  summary: string;
  keywords: string;
}

const ID_TOOLS: Record<IdToolId, IdToolCopy> = {
  merge: {
    title: 'Gabung PDF',
    summary: 'Satukan beberapa PDF menjadi satu dokumen, sesuai urutan pilihan Anda.',
    keywords: 'gabung pdf, gabung pdf online, satukan pdf, merge pdf gratis, tanpa watermark',
  },
  split: {
    title: 'Pisah PDF',
    summary: 'Pecah satu dokumen menjadi beberapa file, per rentang, jumlah halaman, ukuran, atau bookmark.',
    keywords: 'pisah pdf, pisah pdf online, potong halaman pdf, split pdf gratis',
  },
  compress: {
    title: 'Kompres PDF',
    summary: 'Perkecil ukuran file tanpa membuat dokumen sulit dibaca.',
    keywords: 'kompres pdf, kecilkan pdf, kompres pdf online, perkecil ukuran pdf gratis',
  },
  'pdf-to-office': {
    title: 'PDF ke Word',
    summary: 'Susun ulang file Word, Excel, atau PowerPoint yang bisa diedit dari sebuah PDF.',
    keywords: 'pdf ke word, pdf ke excel, konversi pdf ke office, ubah pdf ke word gratis',
  },
  'pdf-to-images': {
    title: 'PDF ke Gambar',
    summary: 'Ekspor halaman sebagai JPG, PNG, atau WEBP dengan resolusi pilihan Anda.',
    keywords: 'pdf ke jpg, pdf ke gambar, konversi pdf ke png, pdf ke jpg gratis',
  },
  ocr: {
    title: 'OCR PDF',
    summary: 'Buat hasil pindaian bisa dicari, atau tarik keluar teksnya.',
    keywords: 'ocr pdf, ocr online, pdf hasil scan bisa dicari, ubah scan ke teks gratis',
  },
};

export function idToolCopy(id: string): IdToolCopy | null {
  if (!(ID_TOOL_IDS as readonly string[]).includes(id)) return null;
  return ID_TOOLS[id as IdToolId];
}

export const ID_HOME_TITLE = 'Tool PDF Gratis Online — Gabung, Pisah, Kompres, Konversi, OCR & Tanda Tangan PDF';
export const ID_HOME_DESCRIPTION =
  'Tool PDF online gratis tanpa daftar dan tanpa watermark: gabung, pisah, kompres, konversi PDF ke Office dan gambar, OCR pindaian, proteksi, buka kunci, watermark, dan tanda tangan elektronik. File terhapus otomatis setelah setiap tugas.';
export const ID_HOME_KEYWORDS =
  'tool pdf gratis, gabung pdf, pisah pdf, kompres pdf, pdf ke word, pdf ke jpg, office ke pdf, ocr pdf, buka kunci pdf, tanda tangan pdf, watermark pdf, edit pdf online';

export const ID_TOOLS_TITLE = 'Semua Tool PDF Gratis — Susun, Konversi, Optimasi & Keamanan';
export const ID_TOOLS_DESCRIPTION =
  'Jelajahi semua tool PDF gratis: gabung, pisah, ekstrak halaman, putar, kompres, Office ke PDF, PDF ke Word, Excel dan gambar, OCR, watermark, nomor halaman, enkripsi, buka kunci, redaksi, tanda tangan, dan isi formulir. Tanpa daftar, tanpa watermark — batasnya tertulis di tiap tool.';
export const ID_TOOLS_KEYWORDS =
  'semua tool pdf, gabung pdf online, pisah halaman pdf, kompres pdf gratis, pdf ke word, pdf ke excel, ocr online, buka kunci pdf, watermark pdf, tanda tangan pdf';

export const ID_CATEGORY_LABELS: Record<string, string> = {
  organize: 'Menyusun',
  convert: 'Konversi',
  optimize: 'Optimasi',
  edit: 'Edit',
  security: 'Keamanan',
  document: 'Dokumen',
  ocr: 'OCR',
};

export function idCategoryLabel(category: string): string {
  return ID_CATEGORY_LABELS[category] ?? category;
}
