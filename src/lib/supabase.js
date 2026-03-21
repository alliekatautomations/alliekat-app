import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://julpheuumolnwkthazdj.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1bHBoZXV1bW9sbndrdGhhemRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzc5ODYsImV4cCI6MjA4OTYxMzk4Nn0.i3jI-PjdAUPnbgVn_EXctr0-F158Gbp-r6icrEdvOGM'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// ✅ TEST CONNECTION
supabase.auth.getSession().then((res) => {
  console.log("SUPABASE TEST:", res)
})
