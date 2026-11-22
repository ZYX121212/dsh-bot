import React, { useMemo } from 'react';
import { parseMessage } from './message-format.mjs';

function InlineContent({ nodes }) {
  return nodes.map((node, index) => {
    if (node.type === 'code') return <code key={index} className="dt-md-inline-code">{node.text}</code>;
    if (node.type === 'strong') return <strong key={index}><InlineContent nodes={node.children}/></strong>;
    if (node.type === 'link') return <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><InlineContent nodes={node.children}/></a>;
    return <React.Fragment key={index}>{node.text}</React.Fragment>;
  });
}

export function MessageContent({ text, onCopy }) {
  const blocks = useMemo(() => parseMessage(text), [text]);
  return <div className="dt-message-markdown">{blocks.map((block, index) => {
    if (block.type === 'code') return <div key={index} className="dt-md-code-block">
      <div className="dt-md-code-toolbar"><span>{block.language || '代码'}</span><button type="button" aria-label="复制代码" disabled={typeof onCopy !== 'function'} onClick={() => onCopy?.(block.text)}>复制代码</button></div>
      <pre tabIndex={0} role="region" aria-label={block.language ? `${block.language} 代码块` : '代码块'}><code>{block.text}</code></pre>
    </div>;
    if (block.type === 'heading') { const Heading = `h${block.level}`; return <Heading key={index}><InlineContent nodes={block.children}/></Heading>; }
    if (block.type === 'list') { const List = block.ordered ? 'ol' : 'ul'; return <List key={index} start={block.ordered ? block.start : undefined}>{block.items.map((item, itemIndex) => <li key={itemIndex} value={block.ordered ? item.value : undefined}><InlineContent nodes={item.children}/></li>)}</List>; }
    if (block.type === 'quote') return <blockquote key={index}><p><InlineContent nodes={block.children}/></p></blockquote>;
    return <p key={index}><InlineContent nodes={block.children}/></p>;
  })}</div>;
}

export default MessageContent;
