import { defineConfig, type DefaultTheme } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "CYY's Blog",
  base: '/blog/',
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: nav(),
    sidebar: {
      '/posts/': {
        base: '/posts/',
        items: sidebarGuide()
      },
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/cyy-tag/blog' }
    ]
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
      link: '/posts'
    },
  ]
}

//侧边导航
function  sidebarGuide(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: '算法',
      collapsed: true, //初始状态为折叠按钮
      items: [
        {text: '字符串哈希', link: '/algorithm/string-hash'},
        {text: 'api-example', link: '/algorithm/api-examples'}
      ]
    }
  ]
}
