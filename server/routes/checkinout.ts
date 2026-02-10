import { Router } from 'express';
import { getCheckInOutRecords } from '../notion';

const router = Router();

// Check In/Out API - fetches latest data from Notion database
router.get('/checkinouts', async (req, res) => {
  try {
    const { userName } = req.query;
    
    console.log('Check-in/out API called with userName:', userName);
    
    // Fetch records from Notion database with timeout handling
    let records: any[] = [];
    try {
      records = await Promise.race([
        getCheckInOutRecords(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout after 30 seconds')), 30000)
        )
      ]) as any[];
      console.log('Raw records count:', records.length);
      if (records.length > 0) {
        console.log('Sample record timestamps:', records.slice(0, 3).map(r => ({ staffName: r.staffName, timestamp: r.timestamp })));
      }
    } catch (error: any) {
      console.log('Notion API timeout or error, returning empty records:', error.message);
      records = [];
    }
    
    // Filter records for specific user if userName is provided and get only latest records
    let filteredRecords = records;
    if (userName) {
      filteredRecords = records.filter(record => 
        record.staffName && record.staffName.toLowerCase().includes(userName.toString().toLowerCase())
      );
    }
    
    // Sort by timestamp descending and limit to latest 20 records
    filteredRecords = filteredRecords
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 20);
    
    // Transform the data to match the expected format for the frontend
    const transformedRecords = filteredRecords.map(record => ({
      id: record.id,
      userName: record.staffName,
      userDesignation: '', // Not available in current mapping
      userDepartment: record.shift, // Using shift as department for now
      type: record.type,
      timestamp: record.timestamp,
      approved: record.approved,
      status: record.status,
      responseDetails: record.responseDetails,
      shift: record.shift
    }));

    res.json(transformedRecords);
  } catch (error: any) {
    console.error('Error fetching check-in/out records:', error);
    
    // For any Notion API errors, return empty array instead of failing
    // This ensures the check-in/out page still loads even if Notion is unavailable
    if (error.code === 'notionhq_client_request_timeout' || 
        error.code === 'validation_error' || 
        error.message?.includes('timeout') ||
        error.message?.includes('Notion')) {
      console.log('Returning empty records due to Notion API issues:', error.message);
      return res.json([]);
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch check-in/out records',
      error: error.message 
    });
  }
});

export default router;