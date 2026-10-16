#!/usr/bin/env node

console.log("Hello from the job scheduler!");
console.log("Hi this is a node TEST");

if (process.argv.length > 2) {
  console.log("Args:", process.argv.slice(2).join(" "));
}