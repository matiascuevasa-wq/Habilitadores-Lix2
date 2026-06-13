import { createClient } from '@supabase/supabase-js'
export const supabase = createClient(
  'https://deamrcqmzavwsopqqfps.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlYW1yY3FtemF2d3NvcHFxZnBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyODc0NjAsImV4cCI6MjA5Njg2MzQ2MH0.x4W7ev8-n6sFXTGKaXBZYU10QNiI9TuX24nSU4BfELw'
)