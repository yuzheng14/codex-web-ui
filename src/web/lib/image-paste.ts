import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from '../../shared/images';

export interface DraftImage {
  id: string;
  name: string;
  size: number;
  dataUrl?: string;
}
export interface MessageDraft {
  text: string;
  images: DraftImage[];
  error?: string;
}
export const emptyDraft: MessageDraft = { text: '', images: [] };

export function imagePasteError(files: File[], images: DraftImage[]): string | undefined {
  if (files.some((file) => !IMAGE_TYPES.includes(file.type)))
    return '请粘贴 PNG、JPEG、WebP 或 GIF 图片。';
  if (files.some((file) => file.size === 0)) return '图片为空，请重新复制后粘贴。';
  if (files.length + images.length > MAX_IMAGES) return `每条消息最多添加 ${MAX_IMAGES} 张图片。`;
  if ([...files, ...images].reduce((sum, file) => sum + file.size, 0) > MAX_IMAGE_BYTES)
    return '每条消息的图片总大小不能超过 2 MiB，请缩小图片后重试。';
}

export function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('图片读取失败，请重新粘贴。'));
    };
    reader.onerror = reader.onabort = () => reject(new Error('图片读取失败，请重新粘贴。'));
    reader.readAsDataURL(file);
  });
}
