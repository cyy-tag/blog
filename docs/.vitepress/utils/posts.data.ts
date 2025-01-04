import {createContentLoader } from "vitepress";
import { base } from '../config.mts'

export default createContentLoader('/posts/*/*.md', {
  transform(rawData) {

    const sorteData =  rawData.sort((a, b) => {
      return +new Date(b.frontmatter.date) - +new Date(a.frontmatter.date)
    })

    //拼接base
    return sorteData.map(page => {
      page.url = base + page.url;
      return page;
    });
  }
})
