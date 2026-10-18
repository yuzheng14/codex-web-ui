import type { ItemView } from '../../shared/types';

export function UserMessage({ item }: { item: ItemView }) {
  return (
    <article
      className="message user-message"
      aria-label="你的消息"
      data-prompt-id={item.id}
      tabIndex={-1}
    >
      <div className="message-content">
        {item.questionReplies?.length ? (
          item.questionReplies.map((reply, index) => (
            <div className="user-question-reply" key={index}>
              <blockquote>{reply.question}</blockquote>
              <p className="user-text">{reply.answer}</p>
            </div>
          ))
        ) : (
          <p className="user-text">{item.text}</p>
        )}
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
