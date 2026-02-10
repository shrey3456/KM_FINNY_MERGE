import { Router } from 'express';
import { Client } from '@notionhq/client';

const router = Router();

// Inspect Notion database schema
router.get('/inspect-notion-schema', async (req, res) => {
  try {
    console.log('🔍 Inspecting Notion database schema');
    
    // Initialize Notion client
    const notion = new Client({
      auth: process.env.NOTION_INTEGRATION_SECRET,
    });
    
    // Use the specific order database ID
    const ORDER_DATABASE_ID = '296851d9af9e4a14966376e58f8475e5';
    
    console.log(`🔍 Database ID: ${ORDER_DATABASE_ID}`);
    
    // Get database schema
    const database = await notion.databases.retrieve({
      database_id: ORDER_DATABASE_ID
    });
    
    console.log('🔍 Database properties:');
    const properties = Object.keys(database.properties);
    properties.forEach(prop => {
      console.log(`  - ${prop} (${database.properties[prop].type})`);
    });
    
    // Also get a sample record to see actual data
    const sampleQuery = await notion.databases.query({
      database_id: ORDER_DATABASE_ID,
      page_size: 1
    });
    
    let sampleProperties = {};
    if (sampleQuery.results.length > 0) {
      const sample = sampleQuery.results[0] as any;
      sampleProperties = Object.keys(sample.properties).reduce((acc, key) => {
        const prop = sample.properties[key];
        let value = null;
        
        // Extract value based on property type
        if (prop.title && prop.title.length > 0) {
          value = prop.title[0].plain_text;
        } else if (prop.rich_text && prop.rich_text.length > 0) {
          value = prop.rich_text[0].plain_text;
        } else if (prop.number !== null) {
          value = prop.number;
        } else if (prop.select) {
          value = prop.select.name;
        } else if (prop.date) {
          value = prop.date.start;
        } else if (prop.rollup) {
          value = prop.rollup.type + ' rollup';
        } else if (prop.formula) {
          value = 'formula result';
        }
        
        return { ...acc, [key]: { type: prop.type, value } };
      }, {});
    }
    
    res.json({
      success: true,
      databaseId: ORDER_DATABASE_ID,
      properties: database.properties,
      propertyNames: properties,
      sampleRecord: sampleProperties,
      totalRecords: sampleQuery.results.length > 0 ? '1+' : '0'
    });
    
  } catch (error) {
    console.error('Schema inspection error:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Failed to inspect schema'
    });
  }
});

export default router;