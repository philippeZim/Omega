const add = (a, b) => a + b;
let total = 0;
for (let i = 0; i < 5; i++) total = add(total, i);
console.log(`total = ${total}`);
