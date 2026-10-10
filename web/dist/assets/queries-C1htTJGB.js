<<<<<<<< HEAD:web/dist/assets/queries-DE66Ds7l.js
import{h as e}from"./button-B7yMy2z2.js";import{t}from"./queryOptions-Ds4CCvaW.js";function n(n=`anthropic`){let r=n===`openai`?`?platform=openai`:`?platform=anthropic`;return t({queryKey:[`panel`,`model-policy`,n],queryFn:()=>e(`/api/panel/model-policy${r}`)})}function r(){return t({queryKey:[`panel`,`models`],queryFn:()=>e(`/api/panel/models`)})}export{r as n,n as t};
========
import{h as e}from"./button-B7yMy2z2.js";import{t}from"./queryOptions-CYWgYn5i.js";function n(n=`anthropic`){let r=n===`openai`?`?platform=openai`:`?platform=anthropic`;return t({queryKey:[`panel`,`model-policy`,n],queryFn:()=>e(`/api/panel/model-policy${r}`)})}function r(){return t({queryKey:[`panel`,`models`],queryFn:()=>e(`/api/panel/models`)})}export{r as n,n as t};
>>>>>>>> a3d97c5 (fix(panel): rebuild and restart backend during updates):web/dist/assets/queries-C1htTJGB.js
