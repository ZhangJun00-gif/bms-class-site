import knowledgeAuthoringGuideMarkdown from '../../../../docs/KNOWLEDGE_BASE_FILE_AUTHORING_GUIDE.md?raw';

export const KNOWLEDGE_AUTHORING_GUIDE_FILENAME =
  'KNOWLEDGE_BASE_FILE_AUTHORING_GUIDE.md';

export { knowledgeAuthoringGuideMarkdown };

export function downloadKnowledgeAuthoringGuide() {
  const blob = new Blob([knowledgeAuthoringGuideMarkdown], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = KNOWLEDGE_AUTHORING_GUIDE_FILENAME;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
