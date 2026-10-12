# Requirements

## Information

- The folder `calibre-9.15.0` contains the source code for an ebook library and reader application
- The Calibre UI is to be taken as a reference for changes to the yacGCDscraper

## UI Updates

- Change the main window to have the same look and feel as Calibre, with
  - the folder view on the left
  - an information panel on the right
  - a selectable carosel of covers middle top
  - a list view of the folder contents in the middle bottom
  - the information panel should display data for the selected row/cover
  - selecting a cover should also select the row
  - selecting a row should also select the cover
  - all panels should have a display toggle

As with calibre, the data in the list view should be editable.
A context menu should have the option to open a window to allow editing the 'metadata'
There should be a button on the information panel to also open the same window that allows editing the 'metadata'

There functionality of the window should be similar to Calibre, where

- rows are sortable in the list view
- fields are editable in the list view
- a search can be made, in this case against the gcd_data
- selection of a search result updates the 'metadata'
- a save on this window updates the database
- a next and previous button navigate to the next record, without saving.  
  - There should be a save popup if changes have been made.
  - 'Yes' save and navigate
  - 'No' discard changes and navigate

## Additional

The cover art should be displayed in the information panel (as in Calibre)
The `GCD enrichment` and `GCD matching` section are not required in the `details` panel
`GCD matching` fuctionality should be available in the `Edit comic information` window
Calibre offers bulk update over a number of metadata fields.  Add this functionality updating the fields:

- Title
- Issue 
- Volume
- Publisher

Where fields are numeric (e.g. Issue, Volume) the option to make incremental updated starting from the initial number should be available as a checkbox
