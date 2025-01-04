import { defineConfig, type DefaultTheme } from 'vitepress'
import footnote from 'markdown-it-footnote';
import { generateSidebar } from './utils/generateSidebar'

const base = "";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "CYY's Blog",
  base: base,
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: nav(),
    sidebar: {
      '/posts/': {
        items: sidebarGuide()
      },
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/cyy-tag/blog' }
    ]
  },
  markdown: {
    config: (md) => {
      md.use(footnote);
    }
  }
})

//首页导航
function nav(): DefaultTheme.NavItem[] {
  return [
    {
      text: 'Home',
      link: '/'
    },
    {
      text: "Posts",
      link: '/posts/'
    },
  ]
}

//侧边导航
function  sidebarGuide(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: 'C++',
      collapsed: true, //初始状态为折叠按钮
      items: generateSidebar('./docs/posts/C++')
    },
  ]
}

//导出base属性
export { base };
