<script setup lang="ts">
// @ts-ignore
import { data as posts } from '../utils/posts.data.ts'
</script>

<template>
  <h1 class="recent_post">Recent Posts</h1>
  <ul class="post_list">
    <li v-for="post of posts">
      <date>{{ post.frontmatter.date }}</date><br>
      <a :href="post.url" class="post_url">{{ post.frontmatter.title }}</a>
    </li>
  </ul>
</template>

<style scoped>
.recent_post {
  
}

.post_url {
  font-size: 20px;
  text-decoration: none;
}

.post-url:hover {
  text-decoration: underline;
}

</style>
