import { supabase } from './lib/supabase'

export async function saveRepairCase(caseData) {
  const { data, error } = await supabase
    .from('repair_cases')
    .insert([caseData])

  if (error) {
    console.error('Error saving repair case:', error)
    return null
  }

  console.log('Saved:', data)
  return data
}
