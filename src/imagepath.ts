export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
}
