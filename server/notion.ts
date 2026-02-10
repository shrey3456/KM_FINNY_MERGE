import { Client } from "@notionhq/client";

// Initialize Notion client
export const notion = new Client({
    auth: process.env.NOTION_INTEGRATION_SECRET!,
});

// Extract the page ID from the Notion page URL
function extractPageIdFromUrl(pageUrl: string): string {
    const match = pageUrl.match(/([a-f0-9]{32})(?:[?#]|$)/i);
    if (match && match[1]) {
        return match[1];
    }

    throw Error("Failed to extract page ID");
}

export const NOTION_PAGE_ID = extractPageIdFromUrl(process.env.NOTION_PAGE_URL!);

// Check In/Out Database ID
export const CHECKINOUT_DATABASE_ID = "6573c30345f8428180ba66f5ec8dff71";

/**
 * Get all check-in/out records from the Notion database
 * @returns {Promise<Array>} - Array of check-in/out records
 */
export async function getCheckInOutRecords() {
    try {
        // Minimal query to test database access
        console.log('Attempting to query Notion database:', CHECKINOUT_DATABASE_ID);
        const response = await notion.databases.query({
            database_id: CHECKINOUT_DATABASE_ID,
            page_size: 20 // Start with fewer records
        });
        console.log('Successfully queried Notion database, got', response.results.length, 'records');

        return response.results.map((page: any) => {
            const properties = page.properties;

            // Extract date from "New Response Details :" field
            const responseDetails = properties["New Response Details :"]?.rich_text?.[0]?.plain_text || "";
            
            // Extract staff name - try multiple field types
            let staffName = "Unknown";
            const staffNameProperty = properties["Staff Name :"];
            
            if (staffNameProperty?.title?.[0]?.plain_text) {
                staffName = staffNameProperty.title[0].plain_text;
            } else if (staffNameProperty?.rich_text?.[0]?.plain_text) {
                staffName = staffNameProperty.rich_text[0].plain_text;
            } else if (staffNameProperty?.select?.name) {
                staffName = staffNameProperty.select.name;
            }
            
            console.log('Extracted staff name:', staffName, 'from property:', JSON.stringify(staffNameProperty, null, 2));
            
            // Extract status
            const status = properties["Status :"]?.select?.name || "Unknown";
            
            // Extract shift
            const shift = properties["Shift"]?.select?.name || "Unknown";
            
            // Look for IN/OUT in any of the properties
            let type = "unknown";
            
            // Check all text fields for IN/OUT indicators
            const allText = Object.values(properties).map((prop: any) => {
                if (prop?.rich_text?.[0]?.plain_text) return prop.rich_text[0].plain_text;
                if (prop?.title?.[0]?.plain_text) return prop.title[0].plain_text;
                if (prop?.select?.name) return prop.select.name;
                return "";
            }).join(" ").toUpperCase();
            
            // More specific IN/OUT detection
            if (allText.includes(" IN ") || allText.includes("CHECK IN") || allText.includes("CHECKIN")) {
                type = "in";
            } else if (allText.includes(" OUT ") || allText.includes("CHECK OUT") || allText.includes("CHECKOUT")) {
                type = "out";
            } else if (allText.includes("IN") && !allText.includes("OUT")) {
                type = "in";
            } else if (allText.includes("OUT")) {
                type = "out";
            }

            // Try to extract timestamp from response details if it contains a date
            let timestamp = page.created_time;
            const dateMatch = responseDetails.match(/(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/);
            if (dateMatch) {
                try {
                    const dateStr = dateMatch[1];
                    const parsedDate = new Date(dateStr);
                    if (!isNaN(parsedDate.getTime())) {
                        timestamp = parsedDate.toISOString();
                    }
                } catch (e) {
                    // Use default timestamp if parsing fails
                }
            }

            return {
                id: page.id,
                staffName,
                responseDetails,
                status,
                shift,
                type,
                timestamp,
                approved: status?.toLowerCase() === "approved" || status?.toLowerCase() === "complete"
            };
        });
    } catch (error: any) {
        console.error("Error fetching check-in/out records from Notion:", error);
        console.error("Full error details:", JSON.stringify(error, null, 2));
        throw new Error("Failed to fetch check-in/out records from Notion");
    }
}