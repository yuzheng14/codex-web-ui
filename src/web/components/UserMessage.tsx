import type { ItemView } from '../../shared/types';

export function UserMessage({ item }: { item: ItemView }) {
  return (
    <article className="message user-message" aria-label="你的消息" data-prompt-id={item.id}>
      <div className="message-content">
        <p className="user-text">{item.text}</p>
        {item.images && (
          <div className="message-images">
            {item.images.map((image, index) => (
              <img key={index} src={image} alt={`已发送的图片 ${index + 1}`} loading="lazy" />
            ))}
          </div>
        )}
        {(item.imageCount ?? 0) > (item.images?.length ?? 0) && (
          <p className="subtle">
            {(item.imageCount ?? 0) - (item.images?.length ?? 0)} 张图片未提供预览
          </p>
        )}
        {item.error && <p className="inline-error">{item.error}</p>}
      </div>
    </article>
  );
}
