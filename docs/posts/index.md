# 欢迎来到我的博客

## 所有文章
<script setup>
  import { data as posts } from '../.vitepress/utils/posts.data.ts'
</script>

<ul>
  <li v-for="post in posts">
    <a :href="post.url">{{ post.frontmatter.title }}</a>
  </li>
</ul>
