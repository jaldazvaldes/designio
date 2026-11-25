const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Id corto y aleatorio (funciona en Node y en el navegador). */
export function newId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Convierte un nombre en un slug para archivos: «Revisión visual b281» → «revision-visual-b281». */
export function slugify(text: string, max = 60): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'documento';
}
