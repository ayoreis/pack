import { inverse, } from 'https://esb.deno.dev/https://deno.land/std@0.153.0/fmt/colors.ts'

console.log(inverse(new Error().stack))