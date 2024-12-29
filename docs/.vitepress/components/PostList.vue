<script setup lang="ts">
// @ts-ignore
import { data as posts } from '../utils/posts.data.ts'
</script>

<template>
  <h1 class="recent_post">Recent Posts</h1>
  <br><div id="test"></div><br>
  <ul class="post_list">
    <li v-for="post of posts">
      <date>{{ post.frontmatter.date }}</date><br>
      <a :href="post.url" class="post_url">{{ post.frontmatter.title }}</a>
      <p class="description">{{ post.frontmatter.description }}</p>
    </li>
  </ul>
</template>

<style scoped>
/* 去掉有序列表和无序列表的默认样式 */
.post_list {
  display: flex;
  justify-content: center;
  align-items: center;
  padding-right: 300px;
}

#test {
  width: 600px;
  height: 2px;
  /* background: linear-gradient(to left, #fff 10%, gainsboro 80%, #fff 85%); */
  background-color: gray;
  margin: auto;
}

.recent_post {
  margin-top: 100px;
  text-align: center;
}

.post_url {
  font-size: 20px;
  text-decoration: none;
}

.post_url:hover {
  text-decoration: underline;
}

.description {
  margin-top: 0%;
}

</style>
