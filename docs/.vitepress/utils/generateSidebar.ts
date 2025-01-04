import { defineConfig, type DefaultTheme } from 'vitepress'
import fs from 'fs';
import path from 'path';

export function generateSidebar(dir: string): DefaultTheme.SidebarItem[] {
  const sidebar: DefaultTheme.SidebarItem[] = [];
  const files = fs.readdirSync(dir, { withFileTypes: true });

  files.forEach((file) => {
    const fullPath = path.join(dir, file.name);
    const fullPathRelativeToDocs = path.relative('./docs', fullPath);

    if (file.name.endsWith('.md') && file.name !== 'index.md') {
      // 如果是 Markdown 文件，添加到侧边栏
      const relativePath = fullPathRelativeToDocs.startsWith('.') ? fullPathRelativeToDocs.slice(2) : fullPathRelativeToDocs;
      sidebar.push({
        text: file.name.replace(/\.md$/, ''),
        link: `/${relativePath.replace(/\\/g, '/').replace(/\.md$/, '')}`
      });
    }
  });
  console.log(sidebar)
  return sidebar;
}