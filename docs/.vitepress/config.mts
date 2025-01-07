import { defineConfig, type DefaultTheme } from 'vitepress'
import footnote from 'markdown-it-footnote';
import markdownItKatex from 'markdown-it-katex'
import { generateSidebar } from './utils/generateSidebar'

const customElements = [
  'math', 'maction', 'maligngroup', 'malignmark', 'menclose', 'merror',
  'mfenced', 'mfrac', 'mi', 'mlongdiv', 'mmultiscripts', 'mn', 'mo', 'mover',
  'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mscarries', 'mscarry',
  'msgroup', 'msline', 'mspace', 'msqrt', 'msrow', 'mstyle', 'msub',
  'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover',
  'semantics', 'annotation', 'annotation-xml'
]

const base = "/blog/";

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
      md.use(markdownItKatex);
    }
  },
  head: [
    ['link', { rel: 'stylesheet', 
               href: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.5.1/katex.min.css',
               crossorigin: '' 
            }
    ]
  ]
  // vue: {
  //   template: {
  //     compilerOptions: {
  //       isCustomElement: (tag) => customElements.includes(tag)
  //     }
  //   }
  // }
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
    {
      text: "数据结构与算法",
      collapsed: true,
      items: generateSidebar('./docs/posts/datastruct & algorithm')
    }
  ]
}

//导出base属性
export { base };
